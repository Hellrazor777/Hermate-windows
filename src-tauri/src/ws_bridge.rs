//! WebSocket client for the webview.
//!
//! Hermes only accepts a `/api/ws` upgrade whose `Origin` header names its own bound host and port
//! (or has no Origin at all). A webview always sends an Origin (`http://localhost:<dev port>` or
//! `http://tauri.localhost`), so a browser-side WebSocket is refused with HTTP 403 (verified live
//! against Hermes 0.23.1; see docs/PROTOCOL.md). This module opens the socket from Rust instead,
//! where no Origin is sent, and streams frames to the webview over a Tauri channel.
//!
//! The URL carries the session token: it is never logged, and no error text includes it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_CONNECTIONS: usize = 8;

/// What the webview is told about a socket.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum WsEvent {
    Open,
    Message { data: String },
    Close { code: Option<u16>, reason: String },
    Error { message: String },
}

#[derive(Debug)]
pub enum Outgoing {
    Text(String),
    Close,
}

/// Only `ws://` / `wss://` URLs whose path ends in `/api/ws`: this is a Hermes client, not a general proxy.
pub fn validate_url(url: &str) -> Result<(), String> {
    let parsed = tauri::Url::parse(url).map_err(|_| "invalid WebSocket URL".to_string())?;
    if parsed.scheme() != "ws" && parsed.scheme() != "wss" {
        return Err("only ws:// and wss:// URLs are allowed".into());
    }
    if parsed.host_str().is_none() {
        return Err("the URL has no host".into());
    }
    if !parsed.path().ends_with("/api/ws") || parsed.fragment().is_some() {
        return Err("only the Hermes /api/ws endpoint is allowed".into());
    }
    Ok(())
}

/// A message that is safe to show: never the URL (it holds the token).
fn describe(err: &WsError) -> String {
    match err {
        WsError::Http(resp) => format!("Hermes rejected the connection (HTTP {})", resp.status().as_u16()),
        WsError::Io(e) => format!("connection failed: {}", e.kind()),
        WsError::Tls(_) => "TLS error".to_string(),
        _ => "connection failed".to_string(),
    }
}

/// Connect and pump frames until either side closes. Emits `Open` once connected and exactly one `Close`.
pub async fn run(url: String, mut outgoing: mpsc::UnboundedReceiver<Outgoing>, emit: impl Fn(WsEvent) + Send + 'static) {
    let request = match url.as_str().into_client_request() {
        Ok(r) => r, // tungstenite adds no Origin header
        Err(_) => {
            emit(WsEvent::Error { message: "invalid WebSocket URL".into() });
            emit(WsEvent::Close { code: None, reason: String::new() });
            return;
        }
    };
    let mut socket = match tokio::time::timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async(request)).await {
        Ok(Ok((socket, _response))) => socket,
        Ok(Err(e)) => {
            emit(WsEvent::Error { message: describe(&e) });
            emit(WsEvent::Close { code: None, reason: String::new() });
            return;
        }
        Err(_) => {
            emit(WsEvent::Error { message: "connection timed out".into() });
            emit(WsEvent::Close { code: None, reason: String::new() });
            return;
        }
    };
    emit(WsEvent::Open);

    let (code, reason) = loop {
        tokio::select! {
            incoming = socket.next() => match incoming {
                Some(Ok(Message::Text(text))) => emit(WsEvent::Message { data: text.to_string() }),
                Some(Ok(Message::Close(frame))) => {
                    break frame.map(|f| (Some(u16::from(f.code)), f.reason.to_string())).unwrap_or((None, String::new()));
                }
                Some(Ok(_)) => {} // binary, ping, pong: Hermes speaks text; pings are answered by tungstenite
                Some(Err(e)) => {
                    emit(WsEvent::Error { message: describe(&e) });
                    break (None, String::new());
                }
                None => break (None, String::new()),
            },
            out = outgoing.recv() => match out {
                Some(Outgoing::Text(text)) => {
                    if socket.send(Message::text(text)).await.is_err() {
                        emit(WsEvent::Error { message: "send failed".into() });
                        break (None, String::new());
                    }
                }
                Some(Outgoing::Close) | None => {
                    let _ = socket.close(None).await;
                    break (Some(1000), String::new());
                }
            },
        }
    };
    emit(WsEvent::Close { code, reason });
}

/// Open sockets, by id.
#[derive(Default)]
pub struct WsState {
    next: AtomicU32,
    conns: Mutex<HashMap<u32, mpsc::UnboundedSender<Outgoing>>>,
}

impl WsState {
    /// Register a socket; `None` when too many are open.
    pub fn register(&self) -> Option<(u32, mpsc::UnboundedReceiver<Outgoing>)> {
        let mut conns = self.conns.lock().ok()?;
        if conns.len() >= MAX_CONNECTIONS {
            return None;
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = mpsc::unbounded_channel();
        conns.insert(id, tx);
        Some((id, rx))
    }

    pub fn send(&self, id: u32, msg: Outgoing) -> Result<(), String> {
        let conns = self.conns.lock().map_err(|_| "socket state poisoned".to_string())?;
        conns.get(&id).ok_or_else(|| "no such socket".to_string())?.send(msg).map_err(|_| "socket is closed".to_string())
    }

    pub fn remove(&self, id: u32) {
        if let Ok(mut conns) = self.conns.lock() {
            conns.remove(&id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex as StdMutex};
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

    #[test]
    fn accepts_only_hermes_ws_urls() {
        for ok in ["ws://127.0.0.1:9119/api/ws?token=abc", "wss://h.example.com/api/ws?token=a%2Bb", "wss://h.example.com/base/api/ws"] {
            assert!(validate_url(ok).is_ok(), "{ok}");
        }
        for bad in [
            "http://127.0.0.1/api/ws",
            "https://h.example.com/api/ws",
            "ws://127.0.0.1/other",
            "ws://127.0.0.1/api/ws#frag",
            "ws:///api/ws",
            "file:///api/ws",
            "not a url",
            "",
        ] {
            assert!(validate_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn errors_never_contain_the_url_or_token() {
        let err = WsError::Url(tokio_tungstenite::tungstenite::error::UrlError::NoHostName);
        assert!(!describe(&err).contains("token"));
        assert_eq!(describe(&WsError::Io(std::io::ErrorKind::ConnectionRefused.into())), "connection failed: connection refused");
    }

    #[test]
    fn state_registers_sends_removes_and_caps_connections() {
        let state = WsState::default();
        let (id, mut rx) = state.register().unwrap();
        state.send(id, Outgoing::Text("hi".into())).unwrap();
        assert!(matches!(rx.try_recv(), Ok(Outgoing::Text(t)) if t == "hi"));
        assert!(state.send(id + 100, Outgoing::Close).is_err());
        state.remove(id);
        assert!(state.send(id, Outgoing::Close).is_err());
        let held: Vec<_> = (0..MAX_CONNECTIONS).map(|_| state.register().unwrap()).collect();
        assert!(state.register().is_none());
        drop(held);
    }

    /// Echo server on loopback that records the Origin header (if any) of the upgrade request.
    async fn echo_server(origins: Arc<StdMutex<Vec<Option<String>>>>) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let origins = origins.clone();
                tokio::spawn(async move {
                    let cb = |req: &Request, resp: Response| {
                        let origin = req.headers().get("origin").map(|v| v.to_str().unwrap_or("").to_string());
                        origins.lock().unwrap().push(origin);
                        Ok(resp)
                    };
                    let Ok(mut ws) = tokio_tungstenite::accept_hdr_async(stream, cb).await else { return };
                    while let Some(Ok(msg)) = ws.next().await {
                        if msg.is_text() && ws.send(msg).await.is_err() {
                            break;
                        }
                    }
                });
            }
        });
        port
    }

    async fn next_event(rx: &mut mpsc::UnboundedReceiver<WsEvent>) -> WsEvent {
        tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.expect("event in time").expect("channel open")
    }

    #[tokio::test]
    async fn connects_without_an_origin_header_echoes_and_closes_once() {
        let origins = Arc::new(StdMutex::new(Vec::new()));
        let port = echo_server(origins.clone()).await;
        let (out_tx, out_rx) = mpsc::unbounded_channel();
        let (ev_tx, mut ev_rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(run(format!("ws://127.0.0.1:{port}/api/ws?token=t"), out_rx, move |e| {
            let _ = ev_tx.send(e);
        }));

        assert_eq!(next_event(&mut ev_rx).await, WsEvent::Open);
        out_tx.send(Outgoing::Text("{\"hello\":1}".into())).unwrap();
        assert_eq!(next_event(&mut ev_rx).await, WsEvent::Message { data: "{\"hello\":1}".into() });
        out_tx.send(Outgoing::Close).unwrap();
        assert!(matches!(next_event(&mut ev_rx).await, WsEvent::Close { code: Some(1000), .. }));
        task.await.unwrap();
        assert!(ev_rx.recv().await.is_none(), "exactly one Close, nothing after it");
        assert_eq!(origins.lock().unwrap().as_slice(), &[None], "no Origin header must be sent");
    }

    #[tokio::test]
    async fn reports_a_refused_connection_without_leaking_the_url() {
        // Bind then drop to get a port nothing listens on.
        let port = TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().port();
        let (_out_tx, out_rx) = mpsc::unbounded_channel();
        let (ev_tx, mut ev_rx) = mpsc::unbounded_channel();
        run(format!("ws://127.0.0.1:{port}/api/ws?token=SECRETTOKEN"), out_rx, move |e| {
            let _ = ev_tx.send(e);
        })
        .await;
        let first = next_event(&mut ev_rx).await;
        assert!(matches!(&first, WsEvent::Error { message } if message.starts_with("connection failed")));
        assert!(!format!("{first:?}").contains("SECRETTOKEN"));
        assert!(matches!(next_event(&mut ev_rx).await, WsEvent::Close { code: None, .. }));
    }
}
