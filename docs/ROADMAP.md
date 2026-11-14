# Roadmap

Protocol reference: WebSocket `/api/ws` JSON-RPC (`session.create`, `prompt.submit`, `session.interrupt`, `approval.respond`, `clarify.respond`, streamed events, `profiles.*`, `projects.tree`, `cron.manage`, `voice.*`) plus CLI calls through `shell.exec` (`hermes kanban|cron|mcp|update`). Windows data lives in `%LOCALAPPDATA%\hermes`.

## Phase 1 (MVP)
- [ ] Tauri + TypeScript scaffold, CI on Windows
- [ ] Hermes RPC client (auth, reconnect, typed events), tested against a real install
- [ ] Connection setup: local, remote, SSH-forwarded
- [ ] Streaming chat with markdown
- [ ] Approval / clarify requests
- [ ] Tray icon + edge widget with activity states
- [ ] Credential storage via Windows Credential Manager
- [ ] Settings and preferences store

## Phase 2
Sessions and history, file browser, terminal (xterm.js), quota dashboards, Kanban, cron automations, notifications.

## Phase 3 (optional)
GitHub PRs and issues, bots, voice, review tools, generative UI (sandboxed HTML), Mermaid.

## Out of scope
macOS-only features: notch, Touch ID, Apple Intelligence, iOS Simulator bridge, App Intents, 3D office.
