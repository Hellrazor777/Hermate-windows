# Hermate for Windows: guide for Claude Code

Unofficial Windows companion for Hermes Agent, built with Tauri (Rust + TypeScript). Inspired by the macOS app https://github.com/chryzxc/herm (Swift/SwiftUI, MIT). This is a clean re-implementation, not a port.

## Start here
- `docs/ROADMAP.md`: phases and checklists. Work top-down: Phase 1 first.
- `docs/ISSUES.md` and the GitHub issues (#1-#13) mirror the roadmap.
- `CONTRIBUTING.md`: ground rules (read before coding).

## Reference material (read-only, do not vendor)
Clone the original for design/protocol reference only:
`git clone --depth 1 https://github.com/chryzxc/herm ../herm-ref`
Most useful: `ARCHITECTURE.md` (protocol contracts), `Sources/Herm/HermesRuntime/` (RPC/CLI boundary), `Sources/Herm/Gateway/`, `docs/hermes-compatibility.md`, `Sources/Herm/Office/` (for the 3D scene). Re-derive behaviour; do not copy Swift verbatim without keeping the MIT notice.

## Hermes protocol (summary)
- WebSocket `/api/ws` JSON-RPC (authenticated; loopback for local, WSS for remote, or SSH-forwarded loopback).
- Methods: `session.create`, `prompt.submit`, `session.interrupt`, `approval.respond`, `clarify.respond`, `profiles.*`, `projects.tree`, `cron.manage`, `voice.*`, plus streamed message events.
- CLI via `shell.exec`: `hermes kanban|cron|mcp|update ...`, every command built as quoted words.
- Windows data dir: `%LOCALAPPDATA%\hermes`. Hermes install docs: https://hermes-agent.nousresearch.com/docs/user-guide/windows-native
- The protocol is NOT yet verified against a live Windows install (issue #3). Treat it as a spec to confirm.

## Invariants
- Hermes is authoritative for sessions, agents, models, skills, cron. The app stores preferences only.
- Fail closed: unavailable capability -> explicit unavailable state; never infer from version strings.
- Session isolation: drop streamed events that don't match the open session.
- Credentials only in Windows Credential Manager; never in logs, diagnostics or settings files.

## Stack (planned)
Tauri 2, Rust backend (credentials, tray, process spawning), TypeScript + React frontend, Vite, xterm.js (terminal), react-three-fiber (Office scene). Tests: Vitest for TS, `cargo test` for Rust. Windows CI on `windows-latest`.

## Conventions
Small PRs, one concern each. Tests for the RPC client and state logic. Update README when user-facing behaviour changes. Keep commits focused.
