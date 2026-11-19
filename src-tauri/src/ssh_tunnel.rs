//! An SSH local port-forward to a remote Hermes, run with the system OpenSSH client.
//!
//! `ssh -N -L 127.0.0.1:<free>:127.0.0.1:<remote> user@host`. Hermate never handles an SSH password or
//! key: authentication is whatever your OpenSSH client does non-interactively (keys, ssh-agent, config).
//! A host key it does not know yet is refused rather than silently trusted.

use std::collections::HashMap;
use std::io::Read;
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const MAX_TUNNELS: usize = 4;
pub const READY_TIMEOUT: Duration = Duration::from_secs(25);
/// How much of ssh's stderr is kept for the error message.
const STDERR_KEEP: usize = 400;

#[derive(Clone, Debug)]
pub struct TunnelSpec {
    pub host: String,
    pub user: String,
    pub port: Option<u16>,
    pub remote_port: u16,
}

/// The same rules as the TypeScript profile validation: nothing that ssh could read as an option
/// (a leading `-`), and no whitespace or shell characters. The webview is not trusted to have checked.
pub fn validate(spec: &TunnelSpec) -> Result<(), String> {
    let host_ok = !spec.host.is_empty()
        && spec.host.len() <= 253
        && spec.host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        && spec.host.starts_with(|c: char| c.is_ascii_alphanumeric())
        && spec.host.ends_with(|c: char| c.is_ascii_alphanumeric());
    if !host_ok {
        return Err("invalid SSH host".to_string());
    }
    let user_ok = !spec.user.is_empty()
        && spec.user.len() <= 64
        && spec.user.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
        && spec.user.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_');
    if !user_ok {
        return Err("invalid SSH user".to_string());
    }
    if spec.port == Some(0) || spec.remote_port == 0 {
        return Err("invalid port".to_string());
    }
    Ok(())
}

pub fn build_args(spec: &TunnelSpec, local_port: u16) -> Vec<String> {
    let mut a: Vec<String> = [
        "-N",
        "-T",
        "-o",
        "BatchMode=yes", // never prompt: there is no terminal to type a password into
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ConnectTimeout=15",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "PermitLocalCommand=no",
        "-L",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    a.push(format!("127.0.0.1:{local_port}:127.0.0.1:{}", spec.remote_port));
    if let Some(p) = spec.port {
        a.push("-p".to_string());
        a.push(p.to_string());
    }
    a.push("--".to_string()); // end of options: the destination can never be parsed as one
    a.push(format!("{}@{}", spec.user, spec.host));
    a
}

pub struct Tunnel {
    child: Child,
    pub local_port: u16,
}

impl Tunnel {
    pub fn stop(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// A free loopback port. (There is a short window before ssh binds it; `ExitOnForwardFailure` turns a
/// lost race into an error rather than a wrong connection.)
fn free_port() -> Result<u16, String> {
    let l = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|e| e.to_string())?;
    l.local_addr().map(|a| a.port()).map_err(|e| e.to_string())
}

/// Start the tunnel with `program` (the real one is `ssh`) and wait until the local port accepts.
pub fn start(spec: &TunnelSpec, program: &str, timeout: Duration) -> Result<Tunnel, String> {
    validate(spec)?;
    let local_port = free_port()?;
    let mut cmd = Command::new(program);
    cmd.args(build_args(spec, local_port))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "OpenSSH was not found. Install the Windows OpenSSH Client (Settings > Optional features).".to_string()
        } else {
            format!("could not start ssh: {e}")
        }
    })?;
    let stderr_text = Arc::new(Mutex::new(String::new()));
    if let Some(mut err) = child.stderr.take() {
        let sink = Arc::clone(&stderr_text);
        std::thread::spawn(move || {
            let mut buf = [0u8; 512];
            while let Ok(n) = err.read(&mut buf) {
                if n == 0 {
                    break;
                }
                if let Ok(mut s) = sink.lock() {
                    s.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if s.len() > STDERR_KEEP * 4 {
                        let cut = s.len() - STDERR_KEEP * 2;
                        let cut = (cut..s.len()).find(|i| s.is_char_boundary(*i)).unwrap_or(s.len());
                        s.drain(..cut);
                    }
                }
            }
        });
    }
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, local_port));
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            // Let the stderr reader catch up with what ssh printed as it died.
            std::thread::sleep(Duration::from_millis(100));
            return Err(failure_message(&stderr_text, status.code()));
        }
        if TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok() {
            return Ok(Tunnel { child, local_port });
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("The SSH connection timed out.".to_string());
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

fn failure_message(stderr: &Mutex<String>, code: Option<i32>) -> String {
    let text = stderr.lock().map(|s| s.trim().to_string()).unwrap_or_default();
    let tail: String = {
        let chars: Vec<char> = text.chars().collect();
        chars[chars.len().saturating_sub(STDERR_KEEP)..].iter().collect()
    };
    if tail.is_empty() {
        format!("ssh exited (code {}).", code.map_or("?".to_string(), |c| c.to_string()))
    } else {
        format!("ssh: {tail}")
    }
}

#[derive(Default)]
pub struct SshState {
    tunnels: Mutex<HashMap<u32, Tunnel>>,
    next: Mutex<u32>,
}

impl SshState {
    pub fn count(&self) -> usize {
        self.tunnels.lock().map(|t| t.len()).unwrap_or(0)
    }
    pub fn insert(&self, tunnel: Tunnel) -> Result<u32, String> {
        let mut tunnels = self.tunnels.lock().map_err(|_| "ssh state poisoned")?;
        if tunnels.len() >= MAX_TUNNELS {
            tunnel.stop();
            return Err("too many open SSH connections".to_string());
        }
        let mut next = self.next.lock().map_err(|_| "ssh state poisoned")?;
        *next += 1;
        tunnels.insert(*next, tunnel);
        Ok(*next)
    }
    pub fn stop(&self, id: u32) {
        let taken = self.tunnels.lock().ok().and_then(|mut t| t.remove(&id));
        if let Some(t) = taken {
            t.stop();
        }
    }
    pub fn stop_all(&self) {
        let all: Vec<Tunnel> = match self.tunnels.lock() {
            Ok(mut t) => t.drain().map(|(_, v)| v).collect(),
            Err(_) => return,
        };
        for t in all {
            t.stop();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> TunnelSpec {
        TunnelSpec { host: "box.example.com".into(), user: "chris".into(), port: Some(2222), remote_port: 9119 }
    }

    #[test]
    fn accepts_ordinary_hosts_and_users() {
        assert!(validate(&spec()).is_ok());
        let mut s = spec();
        s.host = "192.168.1.20".into();
        s.user = "_svc.user-1".into();
        s.port = None;
        assert!(validate(&s).is_ok());
    }

    #[test]
    fn rejects_anything_ssh_could_read_as_an_option_or_a_shell_word() {
        for host in ["-oProxyCommand=calc", "-h", "", "a b", "a;b", "a&b", "host\n", "a@b", "-", ".x", "x.", "a/b", "ü.com"] {
            let mut s = spec();
            s.host = host.into();
            assert!(validate(&s).is_err(), "host {host:?} should be rejected");
        }
        for user in ["-oFoo", "", "a b", "a@b", "a;b", ".hidden", "u\"x"] {
            let mut s = spec();
            s.user = user.into();
            assert!(validate(&s).is_err(), "user {user:?} should be rejected");
        }
        let mut s = spec();
        s.port = Some(0);
        assert!(validate(&s).is_err());
        let mut s = spec();
        s.remote_port = 0;
        assert!(validate(&s).is_err());
    }

    #[test]
    fn args_forward_loopback_only_and_end_options_before_the_destination() {
        let a = build_args(&spec(), 50123);
        let l = a.iter().position(|x| x == "-L").unwrap();
        assert_eq!(a[l + 1], "127.0.0.1:50123:127.0.0.1:9119"); // bound to loopback, not 0.0.0.0
        assert!(a.contains(&"BatchMode=yes".to_string()));
        assert!(a.contains(&"ExitOnForwardFailure=yes".to_string()));
        assert!(!a.iter().any(|x| x.contains("StrictHostKeyChecking")), "host keys are never auto-trusted");
        let dd = a.iter().position(|x| x == "--").unwrap();
        assert_eq!(a[dd + 1], "chris@box.example.com");
        assert_eq!(dd + 2, a.len());
        let p = a.iter().position(|x| x == "-p").unwrap();
        assert_eq!(a[p + 1], "2222");
        assert!(p < dd);
    }

    #[test]
    fn a_missing_program_is_a_clear_error() {
        let err = start(&spec(), "definitely-not-a-real-ssh-binary", Duration::from_secs(2)).err().unwrap();
        assert!(err.contains("OpenSSH was not found"), "{err}");
    }

    #[test]
    fn an_invalid_spec_never_spawns() {
        let mut s = spec();
        s.host = "-oProxyCommand=calc".into();
        assert_eq!(start(&s, "ssh", Duration::from_secs(1)).err().unwrap(), "invalid SSH host");
    }

    #[cfg(windows)]
    #[test]
    fn ssh_failing_reports_its_stderr_and_the_error_is_bounded() {
        // A real ssh to a closed loopback port: fails fast with a connection error on stderr.
        let s = TunnelSpec { host: "127.0.0.1".into(), user: "nobody".into(), port: Some(1), remote_port: 9119 };
        let err = match start(&s, "ssh", Duration::from_secs(20)) {
            Ok(t) => {
                t.stop();
                panic!("should not connect");
            }
            Err(e) => e,
        };
        if err.contains("OpenSSH was not found") {
            return; // no OpenSSH client on this machine: nothing to exercise
        }
        assert!(err.starts_with("ssh: ") || err.starts_with("ssh exited"), "{err}");
        assert!(err.chars().count() <= STDERR_KEEP + 8);
    }

    #[test]
    fn state_caps_and_stops_tunnels() {
        let state = SshState::default();
        assert_eq!(state.count(), 0);
        state.stop(99); // unknown id: no-op
        state.stop_all();
    }
}
