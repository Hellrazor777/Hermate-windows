//! Credential storage in the Windows Credential Manager.
//!
//! Invariants (see CLAUDE.md): secrets live only in Credential Manager; they are never logged,
//! never put in error strings, and never written to settings or diagnostics. Callers refer to a
//! secret by an opaque connection id; the secret value only crosses this module's boundary
//! as an argument to `set` and as the return value of `get`.

use keyring::Entry;

const SERVICE: &str = "Hermate";
const MAX_ID_LEN: usize = 128;
/// Credential Manager limits a blob to 2560 bytes (CRED_MAX_CREDENTIAL_BLOB_SIZE) and keyring
/// stores UTF-16, so keep well under it.
const MAX_SECRET_CHARS: usize = 1024;

/// An error that is safe to show or log: it never contains the secret.
#[derive(Debug, PartialEq, Eq)]
pub enum CredentialError {
    InvalidId,
    InvalidSecret,
    Backend(String),
}

impl std::fmt::Display for CredentialError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidId => write!(f, "invalid credential id"),
            Self::InvalidSecret => write!(f, "invalid credential value"),
            Self::Backend(msg) => write!(f, "credential store error: {msg}"),
        }
    }
}

impl std::error::Error for CredentialError {}

fn backend(e: keyring::Error) -> CredentialError {
    // keyring errors describe the failure, not the secret.
    CredentialError::Backend(e.to_string())
}

/// Ids are opaque handles chosen by the app (for example a connection uuid).
pub fn validate_id(id: &str) -> Result<(), CredentialError> {
    let ok = !id.is_empty()
        && id.len() <= MAX_ID_LEN
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'));
    if ok {
        Ok(())
    } else {
        Err(CredentialError::InvalidId)
    }
}

fn validate_secret(secret: &str) -> Result<(), CredentialError> {
    if secret.is_empty()
        || secret.chars().count() > MAX_SECRET_CHARS
        || secret.contains('\r')
        || secret.contains('\n')
    {
        Err(CredentialError::InvalidSecret)
    } else {
        Ok(())
    }
}

fn entry(id: &str) -> Result<Entry, CredentialError> {
    validate_id(id)?;
    Entry::new(SERVICE, id).map_err(backend)
}

pub fn set(id: &str, secret: &str) -> Result<(), CredentialError> {
    validate_secret(secret)?;
    entry(id)?.set_password(secret).map_err(backend)
}

/// `Ok(None)` when no credential is stored under `id`.
pub fn get(id: &str) -> Result<Option<String>, CredentialError> {
    match entry(id)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(backend(e)),
    }
}

/// Deleting a missing credential is not an error.
pub fn delete(id: &str) -> Result<(), CredentialError> {
    match entry(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(backend(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_ids() {
        assert!(validate_id("conn-1.a_b:c").is_ok());
        assert_eq!(validate_id(""), Err(CredentialError::InvalidId));
        assert_eq!(validate_id("has space"), Err(CredentialError::InvalidId));
        assert_eq!(validate_id("a/b"), Err(CredentialError::InvalidId));
        assert_eq!(validate_id(&"x".repeat(129)), Err(CredentialError::InvalidId));
    }

    #[test]
    fn rejects_bad_secrets() {
        assert_eq!(set("ok-id", ""), Err(CredentialError::InvalidSecret));
        assert_eq!(set("ok-id", "a\nb"), Err(CredentialError::InvalidSecret));
        assert_eq!(
            set("ok-id", &"x".repeat(1025)),
            Err(CredentialError::InvalidSecret)
        );
    }

    #[test]
    fn errors_never_contain_the_secret() {
        let secret = "s3cr3t-value-123";
        let err = set("bad id!", secret).unwrap_err();
        assert!(!format!("{err} {err:?}").contains(secret));
    }

    /// Talks to the real Windows Credential Manager.
    #[cfg(windows)]
    #[test]
    fn round_trips_through_credential_manager() {
        let id = format!("test-{}-{}", std::process::id(), line!());
        delete(&id).unwrap();
        assert_eq!(get(&id).unwrap(), None);

        match set(&id, "first") {
            // Some machines refuse CredWrite (Windows error 8); that is the environment, not this code.
            // CI sets HERMATE_REQUIRE_CREDMAN=1 so a broken store fails there instead of skipping.
            Err(CredentialError::Backend(m))
                if m.contains("code 8") && std::env::var_os("HERMATE_REQUIRE_CREDMAN").is_none() =>
            {
                eprintln!("SKIPPED: Credential Manager refused the write on this machine: {m}");
                return;
            }
            other => other.unwrap(),
        }
        assert_eq!(get(&id).unwrap().as_deref(), Some("first"));
        set(&id, "token+with/odd=chars").unwrap(); // overwrite
        assert_eq!(get(&id).unwrap().as_deref(), Some("token+with/odd=chars"));

        delete(&id).unwrap();
        assert_eq!(get(&id).unwrap(), None);
        delete(&id).unwrap(); // idempotent
    }
}
