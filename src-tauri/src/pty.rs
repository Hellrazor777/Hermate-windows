//! A local shell in a pseudo-console (ConPTY), for the terminal pane.
//!
//! The webview never names a program: it picks a shell from a fixed list. Output is streamed as base64
//! (a PTY emits raw bytes, which can split a UTF-8 sequence), input is written as text.

use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

/// More than this many open terminals is almost certainly a bug.
pub const MAX_TERMINALS: usize = 8;
const MAX_COLS: u16 = 500;
const MAX_ROWS: u16 = 200;

#[derive(Clone, Serialize)]
#[serde(tag = "event", rename_all = "lowercase")]
pub enum PtyEvent {
    /// Base64 of raw output bytes.
    Data { data: String },
    Exit { code: Option<u32> },
}

/// The shells a terminal may start. The program is resolved by the OS from PATH.
pub fn shell_command(shell: &str) -> Result<CommandBuilder, String> {
    match shell {
        "powershell" => {
            let mut c = CommandBuilder::new("powershell.exe");
            c.arg("-NoLogo");
            Ok(c)
        }
        "cmd" => Ok(CommandBuilder::new("cmd.exe")),
        _ => Err("unknown shell".to_string()),
    }
}

fn clamp_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.clamp(1, MAX_ROWS),
        cols: cols.clamp(1, MAX_COLS),
        pixel_width: 0,
        pixel_height: 0,
    }
}

struct Terminal {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct PtyState {
    terminals: Arc<Mutex<HashMap<u32, Terminal>>>,
    next: Mutex<u32>,
}

impl PtyState {
    /// Start `shell` in the user's home directory and stream its output to `emit`. Returns the terminal id.
    pub fn open<F>(&self, shell: &str, cols: u16, rows: u16, emit: F) -> Result<u32, String>
    where
        F: Fn(PtyEvent) + Send + Sync + 'static,
    {
        let mut cmd = shell_command(shell)?;
        if let Some(home) = std::env::var_os("USERPROFILE") {
            cmd.cwd(home);
        }
        // Reserve a slot first so the cap holds under concurrent opens.
        let id = {
            let terminals = self.terminals.lock().map_err(|_| "terminal state poisoned")?;
            if terminals.len() >= MAX_TERMINALS {
                return Err("too many open terminals".to_string());
            }
            let mut next = self.next.lock().map_err(|_| "terminal state poisoned")?;
            *next += 1;
            *next
        };
        let pair = native_pty_system()
            .openpty(clamp_size(cols, rows))
            .map_err(|e| format!("could not open a terminal: {e}"))?;
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("could not start the shell: {e}"))?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let killer = child.clone_killer();
        self.terminals
            .lock()
            .map_err(|_| "terminal state poisoned")?
            .insert(id, Terminal { master: pair.master, writer, killer });

        let emit = Arc::new(emit);
        let out = Arc::clone(&emit);
        let reader_thread = std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let b64 = base64::engine::general_purpose::STANDARD;
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                out(PtyEvent::Data { data: b64.encode(&buf[..n]) });
            }
        });
        let terminals = Arc::clone(&self.terminals);
        std::thread::spawn(move || {
            let code = child.wait().ok().map(|s| s.exit_code());
            // Dropping the terminal closes the pseudo-console, which ends the reader thread. Wait for it,
            // so all output is delivered before the exit is reported.
            let gone = terminals.lock().ok().and_then(|mut t| t.remove(&id));
            drop(gone);
            let _ = reader_thread.join();
            emit(PtyEvent::Exit { code });
        });
        Ok(id)
    }

    pub fn write(&self, id: u32, text: &str) -> Result<(), String> {
        let mut terminals = self.terminals.lock().map_err(|_| "terminal state poisoned")?;
        let t = terminals.get_mut(&id).ok_or("terminal is closed")?;
        t.writer.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        t.writer.flush().map_err(|e| e.to_string())
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), String> {
        let terminals = self.terminals.lock().map_err(|_| "terminal state poisoned")?;
        let t = terminals.get(&id).ok_or("terminal is closed")?;
        t.master.resize(clamp_size(cols, rows)).map_err(|e| e.to_string())
    }

    /// Kill the shell; the waiter thread then removes it and reports the exit.
    pub fn close(&self, id: u32) {
        if let Ok(mut terminals) = self.terminals.lock() {
            if let Some(t) = terminals.get_mut(&id) {
                let _ = t.killer.kill();
            }
        }
    }

    pub fn close_all(&self) {
        let ids: Vec<u32> = match self.terminals.lock() {
            Ok(t) => t.keys().copied().collect(),
            Err(_) => return,
        };
        for id in ids {
            self.close(id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    #[test]
    fn only_listed_shells_start() {
        assert!(shell_command("powershell").is_ok());
        assert!(shell_command("cmd").is_ok());
        assert!(shell_command("calc.exe").is_err());
        assert!(shell_command("cmd /c evil").is_err());
        assert!(shell_command("").is_err());
    }

    #[test]
    fn size_is_clamped() {
        let s = clamp_size(0, 0);
        assert_eq!((s.cols, s.rows), (1, 1));
        let s = clamp_size(u16::MAX, u16::MAX);
        assert_eq!((s.cols, s.rows), (MAX_COLS, MAX_ROWS));
    }

    #[cfg(windows)]
    #[test]
    fn runs_a_shell_echoes_input_and_reports_exit() {
        let state = PtyState::default();
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let id = state
            .open("cmd", 80, 24, move |e| {
                let _ = tx.lock().unwrap().send(e);
            })
            .expect("open");
        state.resize(id, 100, 30).expect("resize");
        state.write(id, "echo hermate-pty-marker\r\nexit\r\n").expect("write");

        let mut output = Vec::new();
        let mut exit = None;
        let mut answered = false;
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline && exit.is_none() {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(PtyEvent::Data { data }) => {
                    output.extend(base64::engine::general_purpose::STANDARD.decode(data).unwrap());
                    // ConPTY asks "where is the cursor?" (ESC[6n) and waits. A real terminal (xterm.js)
                    // answers; this test plays the terminal.
                    if !answered && String::from_utf8_lossy(&output).contains("\x1b[6n") {
                        answered = true;
                        state.write(id, "\x1b[1;1R").expect("answer cursor query");
                    }
                }
                Ok(PtyEvent::Exit { code }) => exit = Some(code),
                Err(_) => {}
            }
        }
        assert!(String::from_utf8_lossy(&output).contains("hermate-pty-marker"));
        assert_eq!(exit, Some(Some(0)));
        assert!(state.write(id, "x").is_err(), "a finished terminal is gone");
    }

    #[cfg(windows)]
    #[test]
    fn close_kills_a_running_shell() {
        let state = PtyState::default();
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let id = state
            .open("cmd", 80, 24, move |e| {
                let _ = tx.lock().unwrap().send(e);
            })
            .expect("open");
        state.close(id);
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut exited = false;
        while Instant::now() < deadline && !exited {
            if let Ok(PtyEvent::Exit { .. }) = rx.recv_timeout(Duration::from_millis(200)) {
                exited = true;
            }
        }
        assert!(exited);
    }
}
