//! Launch and own a local Hermes backend (`hermes serve --host 127.0.0.1 --port 0`).
//!
//! Verified live against Hermes 0.23.1 (see docs/PROTOCOL.md): the backend authenticates the
//! `/api/ws` upgrade with the value of `HERMES_DASHBOARD_SESSION_TOKEN`, and prints
//! `HERMES_BACKEND_READY port=<n>` once it listens. The token is generated per spawn, lives only
//! in memory, and is never logged or written to disk.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// CREATE_NO_WINDOW: do not flash a console for the child process.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, PartialEq, Eq)]
pub enum BackendError {
    NotFound,
    Spawn(String),
    Timeout,
    ExitedEarly,
    Token(String),
}

impl std::fmt::Display for BackendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound => write!(f, "Hermes was not found. Install it, or add it to PATH."),
            Self::Spawn(e) => write!(f, "Could not start Hermes: {e}"),
            Self::Timeout => write!(f, "Hermes did not report ready in time."),
            Self::ExitedEarly => write!(f, "Hermes exited before it was ready."),
            Self::Token(e) => write!(f, "Could not generate a session token: {e}"),
        }
    }
}

impl std::error::Error for BackendError {}

pub struct LocalBackend {
    child: Child,
    pub port: u16,
    token: String,
}

impl LocalBackend {
    pub fn token(&self) -> &str {
        &self.token
    }

    /// True while the child process is still running.
    pub fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub fn stop(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for LocalBackend {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

/// Parse `HERMES_BACKEND_READY port=49236` (also accepts `listening on 127.0.0.1:49236`).
pub fn parse_ready_port(line: &str) -> Option<u16> {
    if let Some(rest) = line.split("HERMES_BACKEND_READY port=").nth(1) {
        return leading_port(rest);
    }
    line.split("listening on 127.0.0.1:").nth(1).and_then(leading_port)
}

fn leading_port(s: &str) -> Option<u16> {
    let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok().filter(|p| *p != 0)
}

/// 128 random bits as 32 hex characters.
pub fn generate_token() -> Result<String, BackendError> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| BackendError::Token(e.to_string()))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// `%LOCALAPPDATA%\hermes\bin\hermes.exe` if present, otherwise `hermes` from PATH.
pub fn find_hermes() -> PathBuf {
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let candidate = PathBuf::from(local).join("hermes").join("bin").join("hermes.exe");
        if candidate.is_file() {
            return candidate;
        }
    }
    PathBuf::from("hermes")
}

/// Start a backend and wait until it reports its port.
pub fn start(program: &PathBuf, timeout: Duration) -> Result<LocalBackend, BackendError> {
    let token = generate_token()?;
    let mut command = Command::new(program);
    command
        .args(["serve", "--host", "127.0.0.1", "--port", "0"])
        .env("HERMES_DASHBOARD_SESSION_TOKEN", &token)
        .env("HERMES_DESKTOP", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            BackendError::NotFound
        } else {
            BackendError::Spawn(e.kind().to_string())
        }
    })?;

    let (tx, rx) = mpsc::channel::<u16>();
    // Read both pipes for the life of the process: an unread pipe fills and blocks `hermes serve`.
    // Output is discarded (never logged) apart from the ready line.
    for stream in [
        child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let tx = tx.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                if let Some(port) = parse_ready_port(&line) {
                    let _ = tx.send(port);
                }
            }
        });
    }
    drop(tx);

    match rx.recv_timeout(timeout) {
        Ok(port) => Ok(LocalBackend { child, port, token }),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(BackendError::Timeout)
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            let _ = child.wait();
            Err(BackendError::ExitedEarly)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ready_lines() {
        assert_eq!(parse_ready_port("HERMES_BACKEND_READY port=49236"), Some(49236));
        assert_eq!(parse_ready_port("HERMES_DASHBOARD_READY port=49236"), None);
        assert_eq!(parse_ready_port("  Hermes backend listening on 127.0.0.1:9119"), Some(9119));
        assert_eq!(parse_ready_port("HERMES_BACKEND_READY port=0"), None);
        assert_eq!(parse_ready_port("HERMES_BACKEND_READY port=99999999"), None);
        assert_eq!(parse_ready_port("unrelated output"), None);
    }

    #[test]
    fn tokens_are_32_hex_chars_and_unique() {
        let a = generate_token().unwrap();
        let b = generate_token().unwrap();
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn missing_program_is_not_found() {
        let missing = PathBuf::from("definitely-not-a-real-hermes-binary");
        assert_eq!(start(&missing, Duration::from_secs(1)).err(), Some(BackendError::NotFound));
    }

    /// Starts a real Hermes; run with `cargo test -- --ignored`. Makes no model calls.
    #[test]
    #[ignore]
    fn starts_and_stops_a_real_backend() {
        let mut backend = start(&find_hermes(), STARTUP_TIMEOUT).expect("hermes should start");
        assert!(backend.port > 0);
        assert!(backend.is_running());
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], backend.port));
        std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(3)).expect("port should accept connections");
        backend.stop();
        std::thread::sleep(Duration::from_millis(500));
        assert!(std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(1)).is_err(), "port should be closed after stop");
    }

    #[cfg(windows)]
    #[test]
    fn a_process_that_exits_without_ready_is_reported() {
        let cmd = PathBuf::from("cmd.exe"); // `cmd.exe serve ...` prints something and exits
        let result = start(&cmd, Duration::from_secs(10));
        assert!(matches!(result.err(), Some(BackendError::ExitedEarly) | Some(BackendError::Timeout)));
    }
}
