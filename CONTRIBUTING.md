# Contributing to Hermate for Windows

## Setup
1. Install [Rust](https://rustup.rs), Node 20+, and the Tauri prerequisites for Windows (WebView2, MSVC build tools).
2. Install Hermes Agent natively on Windows and run it.
3. `npm install && npm run tauri dev` .

## Ground rules
- Hermes is authoritative for sessions, agents, models, skills, cron. The app stores preferences only. Never keep a second copy of Hermes data.
- Fail closed: if an RPC/CLI capability is unavailable, show an explicit unavailable state. Don't infer from version strings.
- Session isolation: streamed events must prove they belong to the open session, otherwise drop them.
- Credentials go in Windows Credential Manager, never in logs, diagnostics or settings files.
- Do not copy Swift source verbatim without keeping the MIT notice; prefer re-deriving behaviour from `ARCHITECTURE.md` in the original repo.

## Workflow
Small PRs, one concern each. Comment on an issue before starting to avoid duplicate work. Add tests for the RPC client and state logic.
