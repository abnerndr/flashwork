# P15 — Simplify to a SPEC orchestrator

> Owner named this slice on 2026-10-17: Flashwork becomes an agent orchestrator for projects. Keep the
> shared board between agents so they do not repeat work; remove what the core does not use.

**ADR:** `.claude/adr/013-spec-orchestrator.md`

## Core flow

1. Create a project → pick a folder. Flashwork bootstraps `.flashwork/` and installs/builds
   **Graphify** (`graphifyy[mcp]`, code-only, offline) inside the project. Graphify MCP is wired into
   every Claude / Codex / OpenCode session of that project — always on, no feature flag.
2. **Run SPEC**: paste a prompt or attach a `.md` SPEC. A free **Gemini CLI** pre-pass (`gemini -p`)
   splits it into tasks and picks the best *installed and configured* CLI per task
   (Claude, Codex, OpenCode, Gemini, …). Offline heuristic fallback when Gemini is missing/fails.
3. One CLI pane per task (e.g. changes in 3 areas → 3 CLIs) plus shell terminals when a task asks for
   one. Every lane reads/writes the shared board at `<project>/.flashwork/runs/<runId>/board.md`.
4. Windows: projects on `\\wsl$\<distro>\…` / `\\wsl.localhost\<distro>\…` (or a distro chosen at
   creation) spawn through `wsl.exe -d <distro> --cd <linuxPath>`, and CLIs are detected inside it.

## Keep

Projects, terminals/PTYs, workspace layouts, themes, i18n, Graphify, MCP + Skills marketplace,
Git source control, Token HUD + usage/cost, PromptRun ledger + interrupted resume, handoff, CLI
install/update, providers.

## Remove

Spotify / now playing, Discord presence, remote control, gist sync + backup, dictation, AgentSandbox
(+ codex_app_server), AgentCanvasPOC (+ economy_agents), Flows, FlashworkFloors, Ghostty renderer,
AI Memory, Video pane, Web/browser pane, Todos sidebar + GSD sync (opencode_gsd_plugin,
planning_gate), telemetry, Task Board UI (replaced by Run SPEC). Cargo deps used only by removed code.

## Tasks

1. Removals (frontend, Rust, `lib.rs`, Cargo, i18n keys, persisted-state migration drops removed
   pane kinds).
2. WSL: path parsing + `wsl.exe` spawn + in-distro CLI detection; single `is_wsl()`; session homes.
3. Graphify: install via `uv tool install "graphifyy[mcp]"` (fallback `pipx`), build with
   `--code-only` on project create, MCP always wired.
4. Run SPEC: modal (prompt or `.md`), Gemini planner → N lanes, board moved into the project.
5. CHANGELOG, CONTEXT, PROGRESS, this plan.

## Done when

- `npm run build`, `npm test`, `cargo check`, `cargo test --lib` pass.
- A SPEC touching 3 areas opens 3 CLI panes sharing one board in the project folder.
