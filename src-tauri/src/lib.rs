mod credentials;

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

/// Returns the app version; a trivial command that proves the IPC bridge works.
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            app_version,
            credential_set,
            credential_get,
            credential_delete
        ])
        .run(tauri::generate_context!())
        .expect("error while running Hermate");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_matches_cargo() {
        assert_eq!(app_version(), env!("CARGO_PKG_VERSION"));
    }
}
