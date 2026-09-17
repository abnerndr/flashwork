# Context snapshot — what already exists (2026-09-17)

This is a read of the current `flashwork` tree, not a wish list. Gaps for the IDE program are listed at the end.

## Domain model (shipped)

```
Group → Project → Terminal → Sub-tab (agent or shell) → PTY
```

Projects persist in profile-scoped `projects.json`. PTYs, scrollback, and agent sessions survive restart. Layouts: auto, spotlight, sidebar, custom grid.

## Agents (shipped)

CLIs: Shell, Claude Code, Codex, OpenCode, GitHub Copilot CLI, Gemini, Antigravity, Mimo, Freebuff.

Auto launch classifies a prompt (`classifyTask.ts`) and picks an agent (`selectAgent.ts`) with preference lists per kind (`implement`, `review`, `mechanical`, `explore`, `ui`). UI tasks prefer Antigravity. Handoff between Claude and Codex uses on-disk chunks, not a pasted transcript.

OmniRoute/9router **was removed** (P09 / ADR 009). Agents spawn with vendor CLIs only; Flashwork does not set `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`. There is no OpenRouter.com integration in the tree.

CLI install/update (`agentInstall.ts`, `useCommandInstall.ts`) is no longer Windows-first: native scripts, npm, WinGet, and Homebrew cover Windows, Linux, and macOS. Update uses the same method that installed when known, else npm `@latest`, else the native installer. P10 shipped.

## Token metrics (Claude-only)

- Token HUD (`TokenHud` + `agentCostStore`) only meters panes that are `claude` | `codex` | `opencode` **and** have a session id. Gemini falls through to `claudeSessionId` and is dropped.
- `get_session_cost` errors with `agente sem custo suportado` for other agents. Pricing matches Opus/Sonnet/Haiku names only.
- Home `UsageStrip`: Claude + Codex. Antigravity only in the usage modal. OpenCode summary exists in Tauri and is unused on Home. No Gemini card.
- Resume list `RESUMABLE_AGENTS` = Claude, Codex, OpenCode, Antigravity. No `gemini_sessions.rs`.

**P12** makes every live agent pane identifiable and meters tokens/cost where the vendor writes them.

## Task Board (shipped, incomplete for the program)

- UI: `apps/orchestrator/src/components/TaskBoardView/index.tsx`
- Types: `TaskCard` / `TaskSlicePlan` in `apps/orchestrator/src/lib/types.ts`
- Create form: title, prompt, priority, allowed files, verify commands
- Scheduler: `submitBoardTask.ts`, `planner.ts`, `useTaskBoardScheduler.ts`
- Markdown render of a board for siblings: `boardMarkdown.ts`

**Missing:** upload/attach a `.md` handoff or spec; pick which local MCPs and skills the task may use.

## MCP (shipped)

Unified panel + manager: scan Claude / Codex / OpenCode / Antigravity, Global vs Project scope, add via form / paste / official registry, copy between agents, health check, enable/disable, atomic writes with backup.

Key files: `src/components/McpPanel/`, `src/components/modals/mcp/AddServerFlow.tsx`, `src-tauri/src/mcp_*.rs`.

## Skills (shipped scan/uninstall, no install)

- Scan `~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills`
- Detail + uninstall (respects bundled skills and shared links)
- UI: Skills tab in MCP panel, `SkillsBrowser.tsx`

Commands exist: `skills_scan`, `skills_detail`, `skills_uninstall`. **There is no `skills_install`.**

## Git / GitHub (partial)

- Sidebar `GitControl.tsx`: status, stage/unstage, discard, commit, push, pull, init
- Backend: `src/lib/tauri/git.ts` + worktrees (`worktree_provision`, lock, cleanup)
- Clone: `clone_github_repo`
- App-data GitHub gist sync: `github_sync.rs` (token + gist push/pull of app state — **not** repo SCM)
- Open folder in VS Code: `open_in_vscode`

**Missing:** GitHub auth for repo operations, PR flow, branch UI like VS Code SCM, installing VS Code extensions.

## Project creation (partial)

`NewProjectModal.tsx`: name, color, icon, optional `defaultCwd` (required only for agent sandbox). Folder picker exists (`pickDirectory`).

**Missing:** destination folder mandatory for every project; bootstrap of per-project harness, history, and RAG on that disk path.

## Per-project intelligence (partial)

- Graphify: optional code graph + MCP wiring per repo (`graphify.rs`, `GraphifyView`)
- AI Memory: optional local MCP (`ai_memory.rs`)
- Spec proposed, not fully landed: `apps/orchestrator/docs/superpowers/specs/2026-09-04-project-scoped-context-hub-design.md`

These are feature flags, not a required project bootstrap.

## Visual (partial)

- Themes including a VS Code Dark+ palette (`theme.vscode`)
- Visual styles: Normal vs Clean (`docs/UI_VISUAL_STYLES.md`)
- Fonts: Inter + Cascadia Mono (`docs/BRAND.md`)
- Icons: lucide-react + agent PNGs/SVGs

Owner still wants more readable icons and a more attractive typeface, using VS Code as the visual baseline.

## Canvas (experimental, not N8N)

`AgentCanvasPOC` is an agent-session graph (nodes = subagents/teammates, cost, workers). It is **not** a general workflow canvas (HTTP, filters, text blocks, API fan-out).

## Editor (almost none)

Flashwork orchestrates terminals. Markdown panes and a private browser exist. There is no workbench editor, file tree editor, or extension host.

## Docs already in the app

- `apps/orchestrator/AGENTS.md` / `CLAUDE.md`
- `apps/orchestrator/docs/FEATURES.md`, `OVERVIEW.md`, `CHANGELOG.md`, `BRAND.md`
- Superpowers specs/plans under `apps/orchestrator/docs/superpowers/` (shared session context, project-scoped hub)

## Gaps this program addresses

| # | Gap |
| --- | --- |
| 1 | Task Board cannot attach a `.md` handoff/spec |
| 2 | Task Board cannot select MCPs/skills for a run |
| 3 | No install surface for skills (MCP registry exists; skills do not) |
| 4 | Visual polish: icons + type, VS Code–like workbench chrome |
| 5 | Project = folder + isolated harness/RAG/history |
| 6 | GitHub SCM below VS Code quality; no extension install |
| 7 | No IDE editor behind the orchestrator |
| 8 | Model/token/agent choice still leaks to the developer |
| 9 | No N8N-like flow canvas (beta) |
| 12 | No first-party Anthropic / OpenAI / Gemini API key path |
| 13 | Token HUD / usage widgets are Claude-centric; Gemini and other panes are not identified or metered |
