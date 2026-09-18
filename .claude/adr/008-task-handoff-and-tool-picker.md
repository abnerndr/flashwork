# ADR 008 — Task attachments and per-task tool picker

- Status: accepted
- Date: 2026-09-17
- Tags: task-board, mcp, skills, handoff

## Context

Task cards are `{ title, prompt, allowedFiles, verifyCommands, slicePlan }`. Users often already have a handoff markdown, PRD, or agent dump that describes the work better than the prompt box. MCP servers and skills are global/project-scoped; a task cannot say "only Figma MCP + the qa-validacao skill".

## Decision

1. A task may attach one or more local files, primarily `.md` / `.markdown` / `.mdx`, copied or linked under the project's `.flashwork/history/tasks/<cardId>/attachments/`.
2. On create/edit, Flashwork scans MCP + skills (existing `mcp_scan` / `skills_scan`) and lets the user **select a subset**. Empty selection means "use project defaults" (all enabled for that repo), not "no tools".
3. A checkbox **Restrict to selection** opts into a real allowlist. That allowlist is injected into the board markdown and the spawn bootstrap as a pointer file `tools.json`, not as a giant paste.
4. Attached markdown is **not** inlined into `initialInput` beyond a short pointer + first heading (ADR 002). The agent receives `--add-dir` / an absolute path to the attachments folder.

## Consequences

- `TaskCard` grows `attachments` and `toolSelection` fields; persist via existing `saveTaskCard`.
- Marketplace (plan 02) can be used mid-task to install a skill, then tick it on the card.
- Canvas agent nodes (ADR 007) reuse the same `toolSelection` shape.
