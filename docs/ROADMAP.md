# Hermate for Windows: Roadmap

Protocol reference: WebSocket `/api/ws` JSON-RPC (`session.create`, `prompt.submit`, `session.interrupt`, `approval.respond`, `clarify.respond`, streamed events, `profiles.*`, `projects.tree`, `cron.manage`, `voice.*`) plus CLI calls through `shell.exec` (`hermes kanban|cron|mcp|update`). Windows data lives in `%LOCALAPPDATA%\hermes`.

## Phase 1 (MVP)
- [x] Tauri + TypeScript scaffold, CI on Windows
- [x] Hermes RPC client (auth, reconnect, typed events), tested against a real install (see `docs/PROTOCOL.md`; approval/clarify round trip still unverified)
- [x] Connection setup: local, remote and SSH-forwarded (SSH not yet verified end to end against a real server)
- [x] Streaming chat with markdown (tool rows show name, preview and summary; links are not opened yet)
- [x] Approval / clarify requests (UI built from the Hermes source; a live approval prompt could not be provoked on the dev machine)
- [x] Tray icon + edge widget with activity states
- [x] Credential storage via Windows Credential Manager (write path unverified on the dev machine: error 8; CI enforces it)
- [x] Settings and preferences store

## Phase 2
~~Sessions and history~~ (done: list, open, new, delete), file browser, ~~terminal (xterm.js)~~ (done: local shell pane), quota dashboards, Kanban, ~~cron automations~~ (done: list, add, pause/resume, delete; no edit or run history yet), notifications.

## Phase 3
GitHub PRs and issues, bots, voice, review tools, generative UI (sandboxed HTML), Mermaid.

## Office Preview (3D scene), in scope
A 3D office driven by task status: each bot is a character. Running work sits at computers, review goes to Mission Control, planning uses the Kanban room, idle bots take coffee breaks and wander the garden. Positions persist locally and restore on relaunch.

Approach: Three.js (react-three-fiber) in the Tauri webview. Needs Bots (phase 2/3) and Kanban data first, so it lands after those.
- [ ] Procedural low-poly scene builder (the original builds geometry in code, so few external assets are needed)
- [ ] Static mesh batching / instancing for performance
- [ ] Sky, daylight cycle, warm lighting and post-processing (postprocessing library)
- [ ] Bot characters from avatar seed (shape, eyes, skin-aware colour), updated in place on avatar change
- [ ] Task-status to destination mapping (computers, Mission Control, Kanban room, coffee, garden)
- [ ] Navigation: use a navmesh library (e.g. three-pathfinding) rather than a hand-rolled walking mesh. The original's walking-mesh simulation test is documented as failing (52 issues), so do not copy that approach.
- [ ] Placement store: save positions every 10s and on leaving Office, restore on launch
- [ ] Optional music player (Web Audio)
- [ ] Performance budget: 60fps on integrated GPUs, pause rendering when the view is hidden

## Out of scope
macOS-only features: notch, Touch ID, Apple Intelligence, iOS Simulator bridge, App Intents.
