mod credentials;
mod local_backend;

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

/// Returns the app version; a trivial command that proves the IPC bridge works.
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

pub fn run() {
    tauri::Builder::default()
        .manage(BackendState::default())
        .invoke_handler(tauri::generate_handler![
            app_version,
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
