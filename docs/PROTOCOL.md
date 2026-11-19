# Hermes protocol notes (issue #3)

Verified against Hermes Agent **0.23.1 (2026.9.24)** on Windows 11, `hermes serve`, `desktop_contract: 8`.
"Live" = observed on a running backend. "Source" = read from the installed Hermes source
(`%LOCALAPPDATA%\hermes\hermes-agent\tui_gateway`), not exercised live. Re-verify on new Hermes versions
with the opt-in test in `src/rpc/client.live.test.ts`.

## Starting a backend
`hermes serve --host 127.0.0.1 --port 0` with env `HERMES_DASHBOARD_SESSION_TOKEN=<token you generate>`.
It prints `HERMES_BACKEND_READY port=<n>` (also `Hermes backend listening on 127.0.0.1:<n>`). Live.
A user's own `hermes dashboard` may already be listening on 9119; do not reuse its token.

## Connection
- `ws://127.0.0.1:<port>/api/ws?token=<token>` (`wss` for https). Token in the query; a browser WebSocket cannot set headers. Live.
- A wrong token fails the upgrade. Live.
- Frames are JSON text. Notifications and responses include `"jsonrpc": "2.0"`.
- On connect the server pushes `gateway.ready` (payload: `skin`, `change_events`, `heartbeat`, `replay_epoch`). Live.
  `heartbeat: true` is a feature flag, not a keepalive.
- Keepalive: client sends `gateway.ping`; reply `{"result":{"ok":true}}`. Hermes' own clients use a 45s deadline. Live.
- Unknown methods return `-32601`. Live.

## Server requests (approval, clarify, ...)
- The server asks questions as JSON-RPC **requests** with ids `srq-<12 hex>` (`{id, method, params}`), not as
  `*.request` events. Source.
- A client must send `client.capabilities {"server_requests": true}` once per connection, or the server
  never sends them and the agent waits out its deadline (clarify: 300s). Live: the reply lists the kinds
  (`approval`, `clarify`, `sudo`, `secret`, `tour`, `vault.*`, `preview.*`, `terminal.read`, `theme.*`, ...).
- Answer with a **response frame** carrying the same id, not `approval.respond` / `clarify.respond`. Source.
  - approval: `result: {choice: "once"|"session"|"always"|"deny", all?: bool}`
  - clarify: batch of questions `{qid, question, choices, multi_select}`; answers keyed by `qid`
    (`null` = skipped). Source (`settle_batch`): reply with `result: {answers: {qid: string|null}}`; values are strings
    (a multi-select answer is joined with ", "); an empty `result: {}` is a cancel. `clarify.lock {request_id, question_id, answer}`
    is the per-question alternative. **Not exercised live.**
  - Approval requests carry `command`, `description` and `choices` (for example `["once","session","always","deny"]`, or
    deny-only); only offer choices that are in the list. Hermes redacts secrets in `command` before sending. **Not exercised
    live**: on the test machine a saved "always allow" rule auto-approved `rm -rf` and `chmod -R 777`, so no prompt was raised.
- Observed live on a terminal tool call: `tool.start {tool_id, name, context, args}` (`context` is an ~80-char preview of the
  args) and `tool.complete {tool_id, name, args, duration_s, result}`; `message.complete` also carries `reasoning`.
- `request.cancel` event, `payload: {id, method, reason}`, withdraws a request. Source.
- Unanswered requests are replayed as `open_requests` by `session.resume` / `session.activate` /
  `session.events.since`. Not implemented in the client yet.
- `request.answer {id, result}` is a proxy for answering from a client that did not receive the request.

## Methods exercised live
| Method | Notes |
| --- | --- |
| `profiles.list` | `{profiles: [{name, path, model, provider, last_session, ...}]}` |
| `session.list {limit}` | `{sessions: [{id, title, preview, started_at, message_count, source}]}`; `id` is the *stored* id |
| `session.create {}` | `{session_id, stored_session_id, messages, info}`; `session_id` is a short live id; session is `lazy` and not persisted until a prompt |
| `prompt.submit {session_id, text}` | `{status: "streaming", user_row_id}`, then streamed events |
| `session.delete {session_id}` | takes the **stored** id; refused for active sessions (4023); unknown id gives 4007 |
| `client.capabilities`, `gateway.ping` | see above |

## Streamed events (live)
Event frame: `{method: "event", params: {type, session_id, payload}}`. `session_id` is the **live** id from
`session.create` and is top-level. Order for one turn:
`session.info`, `message.start {turn_id}`, `thinking.delta {text}`, `session.title`,
`message.delta {text, turn_id, segment, offset}`, `message.complete {text, usage, status, persisted_turn}`,
`session.info`. Global events carry `session_id: ""` (for example `sessions.changed`) or none (`gateway.ready`);
the client's session isolation drops these for session-bound listeners and still delivers them to global listeners.
Also seen: `notification.show` (for example low-disk warnings).

## Not yet verified
`session.interrupt`, `session.resume`, `profiles.*` mutations, `projects.tree`, `voice.*`,
a real approval/clarify round trip, `open_requests` replay after reconnect, and remote (WSS) and
SSH-forwarded connections (the tunnel itself is unit-tested; see docs/ROADMAP.md).

## Chat stream semantics (issue #4)
Verified live for plain text turns; the rest is from the Hermes source (`tui_gateway/stream_segments.py`, `tool_progress.py`).
- `message.start {turn_id}`. Every reply frame of a turn carries that `turn_id`.
- `message.delta {text, turn_id, segment, offset}`: `offset` is the **UTF-16 code-unit index inside the segment**, i.e. a JS string index.
  A client appends only when `offset` equals the current segment length, trims an overlapping replay, and ignores a gap.
- `message.interim {text, already_streamed, turn_id, segment}` seals a segment (commentary beside tool calls).
- `message.complete {text, usage, status, persisted_turn}`: final text (repairs gaps). `error {message}` ends a turn with an error.
- Tools (source only): `tool.start {tool_id, name, args, preview?}`, `tool.complete {tool_id, name, args, summary?, duration_s?, result, ...}`,
  `tool.progress`, `tool.generating {name}`. Hermate keeps name, preview, summary and duration, never `result`.
- `thinking.delta` / `reasoning.delta` are interleaved with text; `todo.updated`, `status.update`, `session.usage` also exist (not rendered yet).
- `session.interrupt {session_id}` and `session.close {session_id}` (live id) take the live session id. A live session cannot be
  `session.delete`d until it is closed (error 4023), even after its socket drops.

## Origin gate: the webview cannot open the socket (found by running the app)
Hermes' WebSocket upgrade (`web_server_boundary.ws_host_origin_reason`) requires an `Origin`, when present, to name the bound
host and port; non-web schemes (`file://`, `app://`, `null`) and a missing Origin are accepted. Verified live with raw upgrade
requests against Hermes 0.23.1: no Origin gives 101; `http://localhost:1420` (dev webview), `http://tauri.localhost` and
`https://tauri.localhost` (packaged webview) all give 403; the server's own origin gives 101. A browser `WebSocket` always sends an
Origin, so it can never connect from a Tauri window. Hermate therefore opens the socket in Rust (`src-tauri/src/ws_bridge.rs`,
no Origin) and streams frames to the webview over a Tauri channel (`src/rpc/tauriSocket.ts`). Node scripts and unit tests with a
fake socket cannot see this; only the running app can.

## Cron: `cron.manage` (verified live against Hermes 0.23.1)
- Params: `{action: "list" | "add" | "remove" | "pause" | "resume", name?, schedule?, prompt?, repeat?, continuity?, deliver?, include_disabled?, profile?}`.
  An unknown action is RPC error 4016. There is **no edit** action over RPC (the CLI has `hermes cron edit`).
- `name` doubles as the job lookup for `remove` / `pause` / `resume` (Hermes accepts the id or the name); Hermate sends the `job_id`.
- `list` hides paused jobs unless `include_disabled: true`. Rows: `{job_id, name, schedule, prompt_preview, repeat, deliver, next_run_at,
  last_run_at, last_status, last_error, enabled, state ("scheduled" | "paused"), paused_at, ...}`; timestamps are ISO 8601 with an offset.
  A reply also carries `gateway_running`.
- **A refused action is a normal reply, not an RPC error:** `{success: false, error: "..."}` (a bad schedule lists the accepted forms;
  removing a missing job says "not found"). Clients must check `success`.
- `add` without `deliver` defaults to `deliver: "local"`: output is saved on the Hermes machine and not delivered anywhere.
  Schedule forms: `30m`, `every 2h`, `in 30m` (one-shot), `every monday 9am`, `weekdays at 9am`, a cron expression, or an ISO timestamp.
