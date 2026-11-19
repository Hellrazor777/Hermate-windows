//! HTTP calls to Hermes' dashboard plugin API (Kanban lives at `/api/plugins/kanban/...`).
//!
//! The same Origin gate that refuses a browser-side WebSocket (see `ws_bridge.rs`) applies to a
//! webview's `fetch`, so these requests are made from Rust, with no Origin header. The session
//! token is sent as a bearer header and is never logged or included in an error.

use std::time::Duration;

use serde::Serialize;

const TIMEOUT: Duration = Duration::from_secs(20);
const MAX_BODY: usize = 8 * 1024 * 1024;
const KANBAN_PREFIX: &str = "/api/plugins/kanban/";

#[derive(Debug, PartialEq, Serialize)]
pub struct PluginResponse {
    pub status: u16,
    pub body: String,
}

/// Which Hermes HTTP calls Hermate makes: the Kanban plugin API, and read-only file listing and reading.
/// Upload, delete and mkdir on `/api/files` are deliberately not reachable.
fn allowed(method: &str, path: &str) -> bool {
    let route = path.split_once('?').map_or(path, |(p, _)| p);
    if route.contains("..") || route.contains('\\') || route.contains("//") {
        return false;
    }
    if route.starts_with(KANBAN_PREFIX) {
        return true;
    }
    method == "GET" && (route == "/api/files" || route == "/api/files/read")
}

/// Build the request URL, or say why the call is not allowed. This is a Hermes client for a few routes, not a general proxy.
pub fn build_url(base: &str, method: &str, path: &str) -> Result<tauri::Url, String> {
    let base = tauri::Url::parse(base).map_err(|_| "invalid Hermes URL".to_string())?;
    if base.scheme() != "http" && base.scheme() != "https" {
        return Err("only http:// and https:// Hermes URLs are allowed".into());
    }
    if base.host_str().is_none() || !base.username().is_empty() || base.password().is_some() {
        return Err("invalid Hermes URL".into());
    }
    if path.contains('#') || !allowed(method, path) {
        return Err("that Hermes API call is not allowed".into());
    }
    let prefix = base.path().trim_end_matches('/').to_string();
    let mut url = base.clone();
    let (p, q) = match path.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (path, None),
    };
    url.set_path(&format!("{prefix}{p}"));
    url.set_query(q);
    url.set_fragment(None);
    Ok(url)
}

pub async fn request(base: &str, token: &str, method: &str, path: &str, body: Option<String>) -> Result<PluginResponse, String> {
    if token.is_empty() || token.contains(['\r', '\n']) {
        return Err("missing session token".into());
    }
    let method_name = method;
    let method = match method {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PATCH" => reqwest::Method::PATCH,
        "DELETE" => reqwest::Method::DELETE,
        _ => return Err("method not allowed".into()),
    };
    let url = build_url(base, method_name, path)?;
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "could not start the HTTP client".to_string())?;
    let mut req = client.request(method, url).bearer_auth(token);
    if let Some(b) = body {
        req = req.header("Content-Type", "application/json").body(b);
    }
    let res = req.send().await.map_err(describe)?;
    let status = res.status().as_u16();
    if res.content_length().is_some_and(|n| n as usize > MAX_BODY) {
        return Err("the response was too large".into());
    }
    let bytes = res.bytes().await.map_err(describe)?;
    if bytes.len() > MAX_BODY {
        return Err("the response was too large".into());
    }
    Ok(PluginResponse { status, body: String::from_utf8_lossy(&bytes).into_owned() })
}

/// A message that is safe to show: reqwest errors can embed the URL.
fn describe(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "Hermes did not answer in time".into()
    } else if e.is_connect() {
        "could not reach Hermes".into()
    } else {
        "the request to Hermes failed".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn builds_urls_only_for_the_kanban_api() {
        let u = build_url("http://127.0.0.1:9119", "GET", "/api/plugins/kanban/board?board=a").unwrap();
        assert_eq!(u.as_str(), "http://127.0.0.1:9119/api/plugins/kanban/board?board=a");
        let u = build_url("https://host/hermes/", "GET", "/api/plugins/kanban/boards").unwrap();
        assert_eq!(u.as_str(), "https://host/hermes/api/plugins/kanban/boards");
        for bad in ["/api/ws", "/api/plugins/other/x", "/api/plugins/kanban/../../x", "//evil/api/plugins/kanban/x", "/api/plugins/kanban/x#f"] {
            assert!(build_url("http://127.0.0.1:9119", "GET", bad).is_err(), "{bad}");
        }
        // Files are read-only, and only listing and reading are reachable.
        let u = build_url("http://h:1", "GET", "/api/files?path=C%3A%5CUsers%5Ca..b").unwrap();
        assert_eq!(u.as_str(), "http://h:1/api/files?path=C%3A%5CUsers%5Ca..b");
        assert!(build_url("http://h:1", "GET", "/api/files/read?path=x").is_ok());
        for (m, p) in [
            ("DELETE", "/api/files"),
            ("POST", "/api/files"),
            ("POST", "/api/files/upload"),
            ("POST", "/api/files/mkdir"),
            ("GET", "/api/files/download"),
            ("GET", "/api/files/stream"),
            ("GET", "/api/filesx"),
        ] {
            assert!(build_url("http://h:1", m, p).is_err(), "{m} {p}");
        }
        assert!(build_url("ftp://h", "GET", "/api/plugins/kanban/x").is_err());
        assert!(build_url("http://user:pw@h", "GET", "/api/plugins/kanban/x").is_err());
        assert!(build_url("nonsense", "GET", "/api/plugins/kanban/x").is_err());
    }

    async fn serve(reply: &'static str) -> (u16, tokio::sync::oneshot::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let n = s.read(&mut buf).await.unwrap();
            let _ = tx.send(String::from_utf8_lossy(&buf[..n]).into_owned());
            s.write_all(reply.as_bytes()).await.unwrap();
        });
        (port, rx)
    }

    #[tokio::test]
    async fn sends_a_bearer_token_and_no_origin_and_returns_status_and_body() {
        let (port, seen) = serve("HTTP/1.1 409 Conflict\r\nContent-Length: 15\r\nConnection: close\r\n\r\n{\"detail\":\"no\"}\n").await;
        let res = request(&format!("http://127.0.0.1:{port}"), "tok123", "POST", "/api/plugins/kanban/tasks", Some("{\"title\":\"t\"}".into()))
            .await
            .unwrap();
        assert_eq!(res.status, 409);
        assert!(res.body.contains("detail"));
        let head = seen.await.unwrap().to_lowercase();
        assert!(head.starts_with("post /api/plugins/kanban/tasks "));
        assert!(head.contains("authorization: bearer tok123"));
        assert!(!head.contains("origin:"));
    }

    #[tokio::test]
    async fn errors_never_contain_the_token_or_url() {
        let port = { TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().port() };
        let err = request(&format!("http://127.0.0.1:{port}"), "secrettoken", "GET", "/api/plugins/kanban/board", None).await.unwrap_err();
        assert!(!err.contains("secrettoken") && !err.contains("127.0.0.1"), "{err}");
        assert!(request("http://127.0.0.1:1", "", "GET", "/api/plugins/kanban/board", None).await.is_err());
        assert!(request("http://127.0.0.1:1", "t", "PUT", "/api/plugins/kanban/board", None).await.is_err());
    }
}
