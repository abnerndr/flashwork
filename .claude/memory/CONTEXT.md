# Context snapshot — what already exists (2026-09-23)

This is a read of the current `flashwork` tree, not a wish list. Gaps for the IDE program are listed at the end.

## Domain model (shipped)

```
Group → Project → Terminal → Sub-tab (agent or shell) → PTY
```

Projects persist in profile-scoped `projects.json`. Scrollback files and CLI `sessionId`s can resume agent panes after restart; **live PTY processes do not survive** quit/crash/reboot (P14 / ADR 012). Interrupted Auto / Task Board runs stay on a PromptRun disk ledger for 7 days with a boot offer to Resume in Auto. Layouts: auto, spotlight, sidebar, custom grid.

## Agents (shipped)

CLIs: Shell, Claude Code, Codex, OpenCode, GitHub Copilot CLI, Gemini, Antigravity, Mimo, Freebuff.

Auto and Task Board route through `routeTask` (P07 / ADR 006). A cheap first-party `provider_chat` probe runs when a key is saved (Google → OpenAI → Anthropic, 2500 ms); regex `classifyTask` + `selectAgent` is the offline fallback. UI tasks still prefer Antigravity when that CLI is installed. `api:<provider>` is used only when no coding CLI is installed and a key exists (coding call, reply in the run's `api-reply.md`, no PTY). Home defaults to Auto; an explicit CLI stays behind Choose agent. Token HUD starts collapsed (`showTokenHud`, default off). Handoff between Claude and Codex uses on-disk chunks, not a pasted transcript.

OmniRoute/9router **was removed** (P09 / ADR 009). Agents spawn with vendor CLIs only; Flashwork does not set `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`. There is no OpenRouter.com integration in the tree.

**P11 shipped (first-party provider APIs, ADR 010).** Preferences → Providers: Anthropic, OpenAI, and Gemini keys in the OS keyring; optional CLI env injection; model catalog snapshot + refresh. Backend `provider_chat` calls official vendor HTTPS endpoints only.

CLI install/update (`agentInstall.ts`, `useCommandInstall.ts`) is no longer Windows-first: native scripts, npm, WinGet, and Homebrew cover Windows, Linux, and macOS. Update uses the same method that installed when known, else npm `@latest`, else the native installer. P10 shipped.

## Token metrics (identity shipped; Gemini/OpenCode usage on Home)

- Token HUD lists every live coding-agent pane from `tab.type` + PTY alive flags, labeled `{agent} · {folder}`. Cost is parsed for Claude, Codex, OpenCode, and Gemini when a session id/file exists; other agents stay on the list with `cost: null`.
- Home `UsageStrip`: Claude, Codex, Gemini (tokens today), OpenCode (last 24h cost/tokens). Antigravity stays in the usage modal. No Copilot quota card (CLI has no usage file/subcommand in this slice).
- Gemini sessions: `gemini_sessions.rs` snapshots `~/.gemini/tmp/*/chats/*.jsonl` (skips antigravity slugs). Resume includes Gemini.
- Pricing table covers Claude families, GPT, and Gemini 2.5/2.0 flash + 2.5 pro.

**P12 shipped.** P07 shipped the Auto-without-CLI `api:*` path via `provider_chat`. Token metering for that path still does not map vendor usage onto the HUD (synthetic `api:<provider>:<runId>`).

## Task Board (shipped; P01 attachments + tool picker)

- UI: `apps/orchestrator/src/components/TaskBoardView/index.tsx`
- Types: `TaskCard` / `TaskSlicePlan` / `TaskAttachment` / `TaskToolSelection` in `apps/orchestrator/src/lib/types.ts`
- Create form: title, prompt, priority, allowed files, verify commands, **Attach handoff**, **Restrict tools** (MCP + skills)
- Attachments copy under `{profile}/task-board/attachments/{cardId}/` (migrate to `.flashwork/` with P04)
- Spawn writes `tools.json` via `task_write_tools_json` and points agents at paths (no markdown paste)
- Scheduler: `submitBoardTask.ts`, `planner.ts`, `useTaskBoardScheduler.ts`
- Markdown render of a board for siblings: `boardMarkdown.ts`

**P01 shipped (ADR 008).** Follow-ups: orphan attachment cleanup; optional `--add-dir` for Claude sandbox; planner still sees title/prompt more than attachment bodies.

## MCP (shipped)

Unified panel + manager, labeled **Marketplace**: scan Claude / Codex / OpenCode / Antigravity, Global vs Project scope, add via form / paste / official registry, copy between agents, health check, enable/disable, atomic writes with backup. Equal CTAs: **Add MCP server** (existing registry flow) and **Install skill**.

Key files: `src/components/McpPanel/`, `src/components/modals/mcp/AddServerFlow.tsx`, `src/components/modals/mcp/SkillInstallFlow.tsx`, `src-tauri/src/mcp_*.rs`.

## Skills (shipped scan / install / uninstall)

- Scan `~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills`
- Install from a local folder or a git URL into the shared store `~/.agents/skills/<name>`, with optional links into agent skill dirs
- Detail + uninstall (respects bundled skills and shared links)
- UI: Skills tab in the Marketplace manager, `SkillsBrowser.tsx` + `SkillInstallFlow.tsx`

Commands: `skills_scan`, `skills_detail`, `skills_install`, `skills_uninstall`. No official skills registry in v1.

## Git / GitHub (shipped — P05 / ADR 004)

- Sidebar `GitControl.tsx`: VS Code–like Source Control — branch checkout, fetch, commit-first, more menu (Fetch / Pull / Push / Publish), groups Staged → Changes → Untracked → Conflicts
- GitHub **repo** auth: prefer `gh auth token`, else device flow stored in keyring `flashwork.github.repo`. HTTPS `github.com` push/pull/fetch get `Authorization: Bearer` via process env. Gist backup (`github_sync.rs`) stays separate.
- Publish: add HTTPS `origin` when missing, then `git push -u origin HEAD`. Open pull request opens the GitHub compare URL in the system browser.
- Backend: `git.ts` + `git_control.rs` + `github_auth.rs`. Worktrees unchanged. Clone: `clone_github_repo`. Open folder in VS Code: `open_in_vscode`.

**Missing:** installing VS Code extensions; device flow needs `FLASHWORK_GITHUB_CLIENT_ID` when `gh` is not logged in.

## Project creation (shipped — P04 / ADR 005)

Creating a project requires a destination folder. Flashwork writes `<folder>/.flashwork/` (harness, `rag/STATUS.json`, history) before registering the row in `projects.json`. A folder that already has `.flashwork/` is opened as that project id instead of duplicating. CLI open and “open folder as project” reuse the same bootstrap/detect path.

## Per-project intelligence (partial)

- Graphify + AI Memory still optional feature flags; on create they run in the background and write `.flashwork/rag/STATUS.json` (`exists` | `unavailable`). No hosted embedding API.
- Task Board cards for folder-backed projects: `.flashwork/history/tasks/<id>.json`. Pre-P04 cards stay in profile `task-board.json`.
- Spec proposed, not fully landed: `apps/orchestrator/docs/superpowers/specs/2026-09-04-project-scoped-context-hub-design.md` (run hubs remain under the app profile; `.flashwork/history/runs/README.md` is a pointer).
- Attachments still live under `{profile}/task-board/attachments/{cardId}/` (not yet migrated next to the card JSON).

## Visual (P03 shipped)

- Themes including a VS Code Dark+ palette (`theme.vscode`)
- Visual styles: Normal vs Clean (`docs/UI_VISUAL_STYLES.md`)
- Fonts: Segoe UI Variable / Segoe UI, Inter fallback; Cascadia Code / Cascadia Mono / Sarasa Mono (`docs/BRAND.md`). No Google Fonts CDN.
- Icons: lucide-react via `UiIcon` (16 px, stroke 1.75) + agent brand images at min 16×16. Inactive agent marks stay at opacity ≥ 0.7.
- Workbench chrome: `--workbench-tab-height` 35 px on the title bar and pane headers; focused Normal panes use a 1 px `--accent` border.

GitHub SCM shipped in P05. The in-app editor workbench from P06 was **withdrawn** (P13 / ADR 011). Editing happens in VS Code (`open_in_vscode`).

## Canvas (P08 shipped)

`AgentCanvasPOC` remains the live agent-session inspector. **Flows (beta)** is a separate tab (`canvasFlows`, default off): agent, text, filter, HTTP, and MCP tool nodes. Graphs persist under `.flashwork/history/flows/`. HTTP requires a per-run host confirmation; `http://127.0.0.1` needs `flowsAllowLoopback`.


## Editor (withdrawn — P13 / ADR 011)

P06 Monaco + Open VSX is removed. Files in the explorer preview or open in VS Code. Persisted `kind: 'editor'` panes are dropped on load. Marketplace is MCP + skills only.

## Docs already in the app

- `apps/orchestrator/AGENTS.md` / `CLAUDE.md`
- `apps/orchestrator/docs/FEATURES.md`, `OVERVIEW.md`, `CHANGELOG.md`, `BRAND.md`
- Superpowers specs/plans under `apps/orchestrator/docs/superpowers/` (shared session context, project-scoped hub)

## Gaps this program addresses

| # | Gap |
| --- | --- |
| 4 | ~~Visual polish: icons + type, VS Code–like workbench chrome~~ **P03 shipped.** |
| 5 | ~~Project = folder + isolated harness/RAG/history~~ **P04 shipped.** Remaining: attachment files still profile-scoped; 09-04 project hub not under `.flashwork/` |
| 6 | ~~GitHub SCM below VS Code quality~~ **P05 shipped.** Remaining: device flow needs `FLASHWORK_GITHUB_CLIENT_ID` when `gh` is not logged in |
| 7 | ~~No IDE editor behind the orchestrator~~ **P06 shipped, P13 withdrawn.** Edit in VS Code. |
| 8 | ~~Model/token/agent choice still leaks to the developer~~ **P07 shipped.** Remaining: pin-CLI still available behind Choose agent; API runs have no streaming pane (reply file + toast); HUD expand is session-local until remount |
| 9 | ~~No N8N-like flow canvas (beta)~~ **P08 shipped.** Remaining: MCP nodes are stdio JSON-RPC only; HTTPS still needs a per-run confirm even for known hosts |
| 13 | API-path token metering for Auto-without-CLI — `provider_chat` + `api:*` spawn exist (P11/P07); HUD still does not ingest vendor usage JSON |
