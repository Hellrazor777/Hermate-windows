mod credentials;
mod local_backend;
mod plugin_http;
mod pty;
mod ssh_tunnel;
mod tray;
mod widget;
mod ws_bridge;

use std::sync::Mutex;
use tauri::Manager;

/// The one local Hermes backend this app owns (if any).
#[derive(Default)]
struct BackendState(Mutex<Option<local_backend::LocalBackend>>);

#[derive(serde::Serialize)]
struct LocalBackendInfo {
    port: u16,
    /// Per-spawn session token, for in-memory use by the RPC client only. Never log or persist it.
    token: String,
}

/// Store a secret in Windows Credential Manager under an opaque id.
#[tauri::command]
fn credential_set(id: String, secret: String) -> Result<(), String> {
    credentials::set(&id, &secret).map_err(|e| e.to_string())
}

/// Read a secret back; `None` when nothing is stored. The value is for in-memory use only.
#[tauri::command]
fn credential_get(id: String) -> Result<Option<String>, String> {
    credentials::get(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn credential_delete(id: String) -> Result<(), String> {
    credentials::delete(&id).map_err(|e| e.to_string())
}

/// Start the local backend, or return the one already running.
#[tauri::command]
async fn local_backend_start(app: tauri::AppHandle) -> Result<LocalBackendInfo, String> {
    // Reuse a healthy backend.
    {
        let state = app.state::<BackendState>();
        let mut guard = state.0.lock().map_err(|_| "backend state poisoned".to_string())?;
        if let Some(backend) = guard.as_mut() {
            if backend.is_running() {
                return Ok(LocalBackendInfo {
                    port: backend.port,
                    token: backend.token().to_string(),
                });
            }
            *guard = None;
        }
    }
    // Starting blocks until Hermes reports ready; keep it off the UI thread.
    let backend = tauri::async_runtime::spawn_blocking(|| {
        local_backend::start(&local_backend::find_hermes(), local_backend::STARTUP_TIMEOUT)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    let info = LocalBackendInfo {
        port: backend.port,
        token: backend.token().to_string(),
    };
    let state = app.state::<BackendState>();
    *state.0.lock().map_err(|_| "backend state poisoned".to_string())? = Some(backend);
    Ok(info)
}

#[tauri::command]
fn local_backend_stop(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<BackendState>();
    let taken = state
        .0
        .lock()
        .map_err(|_| "backend state poisoned".to_string())?
        .take();
    if let Some(backend) = taken {
        backend.stop();
    }
    Ok(())
}

/// The running backend's port, if any. Deliberately does not return the token.
#[tauri::command]
fn local_backend_status(app: tauri::AppHandle) -> Result<Option<u16>, String> {
    let state = app.state::<BackendState>();
    let mut guard = state.0.lock().map_err(|_| "backend state poisoned".to_string())?;
    Ok(match guard.as_mut() {
        Some(b) => {
            if b.is_running() {
                Some(b.port)
            } else {
                None
            }
        }
        None => None,
    })
}

/// Show the activity state ("idle", "working", "needs-you", "finished", "offline") on the tray icon.
#[tauri::command]
fn set_tray_state(app: tauri::AppHandle, state: String) -> Result<(), String> {
    let state = tray::ActivityState::parse(&state).ok_or_else(|| "unknown activity state".to_string())?;
    tray::set_state(&app, state)
}

/// Show or hide the edge widget.
#[tauri::command]
fn set_widget_visible(app: tauri::AppHandle, visible: bool) -> Result<(), String> {
    widget::set_visible(&app, visible)
}

/// Bring the main window to the front (used by the widget's "Open" button).
#[tauri::command]
fn show_main_window(app: tauri::AppHandle) {
    tray::show_main_window(&app);
}

/// Call Hermes' Kanban REST API from Rust (the webview's Origin would be refused). The token is a
/// bearer header and is never logged.
#[tauri::command]
async fn plugin_http(
    base_url: String,
    token: String,
    method: String,
    path: String,
    body: Option<String>,
) -> Result<plugin_http::PluginResponse, String> {
    plugin_http::request(&base_url, &token, &method, &path, body).await
}

/// Open a WebSocket to Hermes from Rust (no Origin header, which Hermes requires) and stream its
/// events to the webview. Returns the socket id. The URL contains the token: never log it.
#[tauri::command]
fn ws_open(
    app: tauri::AppHandle,
    url: String,
    on_event: tauri::ipc::Channel<ws_bridge::WsEvent>,
) -> Result<u32, String> {
    ws_bridge::validate_url(&url)?;
    let state = app.state::<ws_bridge::WsState>();
    let (id, rx) = state.register().ok_or_else(|| "too many open connections".to_string())?;
    let cleanup = app.clone();
    tauri::async_runtime::spawn(async move {
        ws_bridge::run(url, rx, move |event| {
            let _ = on_event.send(event);
        })
        .await;
        cleanup.state::<ws_bridge::WsState>().remove(id);
    });
    Ok(id)
}

#[tauri::command]
fn ws_send(app: tauri::AppHandle, id: u32, text: String) -> Result<(), String> {
    app.state::<ws_bridge::WsState>().send(id, ws_bridge::Outgoing::Text(text))
}

#[tauri::command]
fn ws_close(app: tauri::AppHandle, id: u32) {
    let _ = app.state::<ws_bridge::WsState>().send(id, ws_bridge::Outgoing::Close);
}

#[derive(serde::Serialize)]
struct SshTunnelInfo {
    id: u32,
    /// The loopback port that reaches Hermes on the remote host.
    port: u16,
}

/// Forward a loopback port to Hermes on `user@host` over SSH (system OpenSSH, non-interactive).
#[tauri::command]
async fn ssh_tunnel_start(
    app: tauri::AppHandle,
    host: String,
    user: String,
    port: Option<u16>,
    remote_port: u16,
) -> Result<SshTunnelInfo, String> {
    let spec = ssh_tunnel::TunnelSpec { host, user, port, remote_port };
    ssh_tunnel::validate(&spec)?;
    if app.state::<ssh_tunnel::SshState>().count() >= ssh_tunnel::MAX_TUNNELS {
        return Err("too many open SSH connections".to_string());
    }
    // Starting waits for authentication; keep it off the UI thread.
    let tunnel = tauri::async_runtime::spawn_blocking(move || {
        ssh_tunnel::start(&spec, "ssh", ssh_tunnel::READY_TIMEOUT)
    })
    .await
    .map_err(|e| e.to_string())??;
    let port = tunnel.local_port;
    let id = app.state::<ssh_tunnel::SshState>().insert(tunnel)?;
    Ok(SshTunnelInfo { id, port })
}

#[tauri::command]
fn ssh_tunnel_stop(app: tauri::AppHandle, id: u32) {
    app.state::<ssh_tunnel::SshState>().stop(id);
}

/// Start a local shell ("powershell" or "cmd") in a pseudo-console and stream its output. Returns the id.
#[tauri::command]
fn pty_open(
    app: tauri::AppHandle,
    shell: String,
    cols: u16,
    rows: u16,
    on_event: tauri::ipc::Channel<pty::PtyEvent>,
) -> Result<u32, String> {
    app.state::<pty::PtyState>().open(&shell, cols, rows, move |event| {
        let _ = on_event.send(event);
    })
}

#[tauri::command]
fn pty_write(app: tauri::AppHandle, id: u32, text: String) -> Result<(), String> {
    app.state::<pty::PtyState>().write(id, &text)
}

#[tauri::command]
fn pty_resize(app: tauri::AppHandle, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    app.state::<pty::PtyState>().resize(id, cols, rows)
}

#[tauri::command]
fn pty_close(app: tauri::AppHandle, id: u32) {
    app.state::<pty::PtyState>().close(id);
}

/// Returns the app version; a trivial command that proves the IPC bridge works.
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

pub fn run() {
    tauri::Builder::default()
        .manage(BackendState::default())
        .manage(ws_bridge::WsState::default())
        .plugin(tauri_plugin_notification::init())
        .manage(ssh_tunnel::SshState::default())
        .manage(pty::PtyState::default())
        .setup(|app| {
            tray::setup(app.handle())?;
            widget::create(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the main window quits the app (and with it the backend we spawned); the widget
            // must not keep a windowless app alive.
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                window.app_handle().exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_version,
            set_tray_state,
            set_widget_visible,
            show_main_window,
            ws_open,
            plugin_http,
            ws_send,
            ws_close,
            ssh_tunnel_start,
            ssh_tunnel_stop,
            pty_open,
            pty_write,
            pty_resize,
            pty_close,
            credential_set,
            credential_get,
            credential_delete,
            local_backend_start,
            local_backend_stop,
            local_backend_status
        ])
        .build(tauri::generate_context!())
        .expect("error while building Hermate")
        .run(|app, event| {
            // Do not leave a backend we spawned running after the app exits.
            if let tauri::RunEvent::Exit = event {
                let _ = local_backend_stop(app.clone());
                app.state::<ssh_tunnel::SshState>().stop_all();
                app.state::<pty::PtyState>().close_all();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_matches_cargo() {
        assert_eq!(app_version(), env!("CARGO_PKG_VERSION"));
    }
}
