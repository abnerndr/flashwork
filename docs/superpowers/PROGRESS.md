# Flashwork IDE program — execution progress

Last updated: 2026-09-19

Resume here if the session context runs out. Implement **one numbered plan at a time**. Default order: **P09 → P10 → P12 → P11 → P01 → P02 → P04 → P07 → P03 → P05 → P06 → P08**.

Owner (2026-09-17): after each numbered plan, **commit and merge locally to `master`**. Do not push. Do not pause for merge/PR options. The owner will review after **all** remaining plans. Do **not** stop or restart `tauri dev` / Vite. i18n in `en.ts` and `pt-BR.ts`. English in versioned source.

## Shipped (on local `master`, not pushed)

| Plan | Commit | Status |
| --- | --- | --- |
| P09 Remove OmniRoute | `9a18cbc` | done |
| P10 CLI install/update | `b3bdd6f` | done |
| P12 Token metrics all agents | `89c9746` | done (Task 6 skipped — P11 was not shipped yet) |
| P11 First-party provider APIs | `0e0a2fd` | done |
| P01 Task handoff + MCP/skills picker | `772237d` | done |
| P02 Skills + MCP marketplace | `f1cf498` | done |
| P04 Per-project harness/RAG | `ff198a9` | done |
| P07 Opaque model router | `4fd97fb` | done |
| P03 Visual refresh | `2860ea9` | done |
| P05 GitHub source control | `33ae3bd` | done |

## Current slice

**Plan:** P06 — `docs/superpowers/plans/2026-09-17-06-ide-workbench.md`  
**ADR:** `.claude/adr/004-keep-tauri-reference-vscode.md`  
**Branch:** start `feat/p06-ide-workbench` from `master`  
**Status:** not started.

## After P06

Start P08 (`docs/superpowers/plans/2026-09-17-08-canvas-beta.md`) unless the P06 plan or owner says otherwise.

## P07 notes (for later slices)

- Probe order: first saved key among `google`, `openai`, `anthropic` via `provider_chat` + `pickEffectiveRouterModel` (2500 ms, no retry). No OmniRoute / OpenRouter / Groq / Ollama.
- `api:*` only when no coding CLI is installed and a key exists. Reply is `api-reply.md` in the run folder (`write_prompt_run_file`), not a PTY. Run status is `done` after the chat.
- Auto always uses the `routeTask` lane. Task Board reuses that routed slice for probe/`api:*`; fallback still uses `planAutoLanes`.
- Home defaults to Auto; Choose agent still pins a CLI. Token HUD starts collapsed (`showTokenHud`, default false).
- API-path token metering (P12 leftover) is still not wired.

## P01 notes (for later slices)

- Attachments live under `{profile}/task-board/attachments/{cardId}/` (P04 did **not** migrate them to `.flashwork/history/tasks/<cardId>/attachments/`).
- `task_write_tools_json` creates `tools.json`; restrict mode fails closed if the write fails.
- Bootstrap pointers only — no pasted attachment bodies. Optional Claude `--add-dir` for the attachments folder is still a follow-up.
- Orphan attachment files are not cleaned up on chip remove / card delete yet.

## P02 notes (for later slices)

- Skills install from a local folder or git URL into `~/.agents/skills/<name>`; optional links into agent skill dirs. No official skills registry in v1.
- Windows directory-link fallback (`mklink /J`) is compiled but was not exercised on this Linux/WSL box.
- Overwrite deletes a pre-existing non-link folder of the same name in an agent skills dir and replaces it with a link.

## P04 notes (for later slices)

- New projects require a destination folder; `.flashwork/` is published atomically (staging + rename). Foreign id → `flashwork_exists` (open existing). Incomplete home without `project.json` → `flashwork_incomplete`.
- RAG (Graphify ensure + AI Memory MCP sidecar + `rag/STATUS.json`) runs after create and does not block registration.
- Task Board cards for folder-backed projects: `<folder>/.flashwork/history/tasks/<id>.json`. Profile `task-board.json` is the fallback. Listing binds filename stem + `project_id` to that home.
- Run hubs stay under the app profile; `.flashwork/history/runs/README.md` is a one-line pointer. 09-04 hub is not implemented under `.flashwork/`.
- Attachments were not migrated in this slice.

## P05 notes (for later slices)

- Checkout refuses when the working tree has conflicts (`checkout_blocked_conflicts`); no force in v1.
- Repo SCM auth is `github_auth.rs` + keyring `flashwork.github.repo`, not gist `github_sync.rs`. Prefers `gh auth token`; else device flow.
- Device flow is fail-closed until `FLASHWORK_GITHUB_CLIENT_ID` is set (OAuth App with Device Flow). `gh` logged-in users do not need it.
- GitHub HTTPS extraheader (push/pull/fetch) uses process env, not `git -c`. SSH remotes are unchanged.
- Combined Sync CTA was replaced by Fetch / Pull / Push / Publish in the SCM more menu.

## P03 notes (for later slices)

- Type stack is OS-first (Segoe UI Variable / Cascadia Code). Linux/WSL falls back to Inter / Cascadia Mono / system fonts. No Google Fonts CDN.
- `UiIcon` defaults to 16 px and stroke 1.75. Lucide SVGs also inherit `--icon-stroke` from `theme.css`.
- Inline badges (Pin, Pause, Lock, Link2, ShieldCheck, Clock) stayed at 10–12 px.
- Visual check in the running Tauri window was skipped: Vite/Tauri were not listening and must not be started if already owned by the user. `tsc` clean; 552 vitest tests passed.
