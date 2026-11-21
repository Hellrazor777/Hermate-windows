# Hermate for Windows

**Hermate for Windows** is an unofficial Windows companion for [Hermes Agent](https://hermes-agent.nousresearch.com), built with **Tauri** (Rust + TypeScript).

Inspired by [chryzxc/herm](https://github.com/chryzxc/herm), a native macOS (Swift/SwiftUI) app. This is a clean re-implementation for Windows, not a line-by-line port: the Swift UI code can't be reused, so only the *design* and the *Hermes protocol contract* carry over.

> **Status: planning / pre-alpha. Contributors wanted.** See [ROADMAP.md](docs/ROADMAP.md) and the open issues.

## What it is

A frontend only. Hermes keeps sessions, agents and history. This app connects to a running Hermes (local, remote or SSH-forwarded) and gives you:

- an always-available edge/tray widget: idle, working, needs-you, finished, offline
- streaming chat with markdown, tool activity and approval requests
- a local terminal pane (PowerShell or cmd, in the app)
- sessions and history, and scheduled (cron) jobs
- a read-only file browser for the Hermes machine (text and small images)
- usage: credit balance and tokens/cost per model
- chat draws ```mermaid diagrams, and shows ```html blocks as code with a Run preview button. A preview runs in an isolated frame with no network and no access to Hermate.
- desktop notifications when Hermes needs an answer or finishes a reply while Hermate is not in front (turn off under Behaviour). They never contain the reply, command or question text.
- Kanban: view a board, add tasks, comment, and move a task (ready, block, complete, archive)
- later: files, quota, GitHub tools
- the 3D Office Preview: a low-poly office where each bot is a character moving between desks, meeting rooms and the garden based on task status (Three.js)

## Requirements

- Windows 10/11
- Hermes Agent installed natively ([Windows guide](https://hermes-agent.nousresearch.com/docs/user-guide/windows-native)) or reachable remotely

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Pick an issue labelled `good first issue` or any phase-1 item.

## Credits & license

MIT. Design and protocol notes derive from Herm by Christian Rey Villablanca (MIT). Not affiliated with Nous Research or the Herm author.
