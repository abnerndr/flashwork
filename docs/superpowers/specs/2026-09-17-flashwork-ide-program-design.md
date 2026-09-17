# Flashwork IDE program — design

Date: 2026-09-17
Status: proposed (planning only; not implemented)
Builds on: current orchestrator in `apps/orchestrator`, ADRs 001–010, vscode-docs as UX reference

## Problem

Flashwork already orchestrates agents, terminals, MCP, skills, Git, Graphify, and Auto routing. It is not yet an IDE: tasks cannot take a markdown handoff, tools cannot be chosen per task, skills cannot be installed from the app, each project does not own harness/RAG on disk, GitHub SCM is thinner than VS Code, the developer still thinks about agents/models/tokens, and there is no n8n-style automation canvas.

The owner wants those gaps closed **without throwing away** the current system, using [VS Code](https://github.com/microsoft/vscode) and [vscode-docs](https://github.com/microsoft/vscode-docs) as the visual and SCM baseline.

## Non-goals

- Forking or vendoring microsoft/vscode
- Replacing Tauri with Electron
- Hosted billing, cloud RAG, or shipping paid model API keys (users paste their own)
- OpenRouter.com, OmniRoute, or any third-party LLM gateway
- Deleting Agent Canvas POC, Task Board, or MCP panel
- Microsoft Marketplace VSIX that requires the Electron extension host

## Product shape

```
Flashwork (Tauri)
├── Home / workspace / terminals     (keep)
├── Task Board                       (extend: attachments + tool picker)
├── MCP + Skills                     (extend: install marketplace)
├── Source Control                   (raise to vscode-docs SCM behavior)
├── Editor workbench                 (new, behind current panes)
├── Project folder bootstrap         (harness + RAG + history)
├── Auto router                      (opaque; CLI and/or Anthropic/OpenAI/Gemini APIs)
├── CLI lifecycle                    (install + update on Win/Linux/macOS)
└── Flows (beta)                     (n8n-like graph)
```

Workbench layout target (from VS Code, adapted):

```
┌─────────┬──────────────────────────┬────────────┐
│ Sidebar │ Editor / Terminal grid   │ Right bar  │
│ Explorer│                          │ MCP/SCM    │
│ Search  │  [Flows beta tab]        │ Skills     │
│ SCM     │                          │            │
│ Flows   │                          │            │
└─────────┴──────────────────────────┴────────────┘
```

Existing containers and PTY panes remain the default center surface. The editor is an additional pane kind (`kind: 'editor'`), not a replacement for terminals.

## Subsystems

| ID | Name | ADR | Plan |
| --- | --- | --- | --- |
| P01 | Task handoff + MCP/skill picker | 008 | `plans/2026-09-17-01-task-handoff-mcp-skills.md` |
| P02 | Skills & MCP install area | 003 | `plans/2026-09-17-02-skills-mcp-marketplace.md` |
| P03 | Visual refresh (icons, type, vscode density) | 004 | `plans/2026-09-17-03-visual-refresh.md` |
| P04 | Project folder, harness, RAG | 005 | `plans/2026-09-17-04-project-harness-rag.md` |
| P05 | GitHub / SCM like VS Code | 004 | `plans/2026-09-17-05-github-source-control.md` |
| P06 | IDE workbench + Open VSX subset | 004 | `plans/2026-09-17-06-ide-workbench.md` |
| P07 | Opaque model router | 006 | `plans/2026-09-17-07-opaque-model-router.md` |
| P08 | Flows canvas beta | 007 | `plans/2026-09-17-08-canvas-beta.md` |
| P09 | Remove OmniRoute/9router | 009 | `plans/2026-09-17-09-remove-omniroute.md` |
| P10 | CLI install/update Win/Linux/macOS | 009 | `plans/2026-09-17-10-cli-install-update.md` |
| P11 | Anthropic / OpenAI / Gemini APIs | 010 | `plans/2026-09-17-11-provider-apis.md` |
| P12 | Token metrics + identify all CLIs | 011 | `plans/2026-09-17-12-token-metrics-all-agents.md` |

Recommended implementation order: **P09 → P10 → P12 → P11 → P01 → P02 → P04 → P07 → P03 → P05 → P06 → P08**.

Rationale: drop the gateway first; fix CLI install; then token/identity HUD (users already run Gemini panes); add vendor API keys; then Task Board attachments; marketplace; folder bootstrap; opaque router; visual + SCM + editor; canvas last.

## Data contracts (shared)

```ts
// apps/orchestrator/src/lib/types.ts (to add)

export type TaskAttachment = {
  id: string
  sourcePath: string
  storedPath: string
  kind: 'handoff' | 'markdown' | 'spec'
  title: string
}

export type TaskToolSelection = {
  mode: 'projectDefault' | 'restrict'
  mcpServerIds: string[]
  skillNames: string[]
}

export type ProjectHarness = {
  projectId: string
  folder: string
  graphify: boolean
  aiMemory: boolean
  ragReady: boolean
}
```

On disk (per ADR 005):

```
<folder>/.flashwork/
  project.json
  harness/
  rag/
  history/tasks/<cardId>/attachments/
  history/flows/<flowId>.json
```

## Error handling

- Folder picker cancel → no project created.
- `.flashwork/` already exists → open existing or abort.
- Skill install failure → toast + leave other agents unchanged (same atomic backup pattern as MCP upsert).
- Router timeout / no provider key → `classifyTask` + `selectAgent` fallback; never block the task.
- CLI install fails → keep previous binary; show PTY log + docs URL (P10).
- Provider 401 → `provider_unauthorized`; do not retry; do not fall through to OpenRouter.
- HTTP canvas node → confirm host; refuse RFC1918 unless user checks "allow private networks".
- Extension install incompatible with monaco-vscode-api → disable with reason, do not crash the workbench.

## Testing

- Vitest for TS contracts, planner, markdown attach parsing, tool allowlist merge.
- `cargo test --lib` for new Tauri commands (`skills_install`, `project_bootstrap`, `github_auth`, `provider_key_set`, `provider_chat`).
- i18n: `tsc` fails if keys missing.
- Do not require a running `tauri dev` restart to validate UI; HMR + component tests.

## VS Code mapping (behavior we copy, not code we paste)

| VS Code (docs) | Flashwork target |
| --- | --- |
| File explorer + editor tabs | Pane kind `editor` + project file tree |
| Source Control view | Evolve `GitControl` toward vscode SCM groups |
| GitHub PR / publish | After GitHub device/OAuth login, push + open PR URL |
| Extensions view | Open VSX subset inside marketplace (P02/P06) |
| Settings / JSON | Keep Preferences modal; add project `harness/` files |

Public docs: [VS Code documentation](https://code.visualstudio.com/docs). Source of docs: [vscode-docs](https://github.com/microsoft/vscode-docs). Product source: [vscode](https://github.com/microsoft/vscode).

## Spec self-review

- No TBD sections: each subsystem has a plan file.
- No contradiction with ADR 001 (keep Tauri) or ADR 004 (no vscode fork).
- Scope is a program of twelve plans, not one PR.
- Ambiguity resolved: "use vscode as base" means UX/SCM/editor services, not a fork. "Remove OpenRouter" means remove OmniRoute/9router (there is no OpenRouter code).
