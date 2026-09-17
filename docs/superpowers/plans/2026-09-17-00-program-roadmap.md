# Flashwork IDE program — roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement **one numbered plan at a time**. This file is the index, not an implementation checklist for code.

**Goal:** Sequence independent, testable slices that turn Flashwork into an IDE while keeping the current orchestrator, dropping the OmniRoute gateway, fixing CLI + first-party APIs, and metering every agent — not only Claude.

**Architecture:** Extend `apps/orchestrator` only. Persistence grows from profile `projects.json` plus per-folder `.flashwork/`. VS Code is a UX reference. No OpenRouter/9router hop.

**Tech Stack:** Tauri 2, Rust, React 18, Zustand, Vitest, existing MCP/skills/git/prompt-run modules, OS keyring for provider keys.

---

## Order

| Seq | Plan file | Depends on | User-visible outcome |
| --- | --- | --- | --- |
| 0 | this file | — | Shared vocabulary |
| 9 | `2026-09-17-09-remove-omniroute.md` | current OmniRoute | No 9router gateway |
| 10 | `2026-09-17-10-cli-install-update.md` | — | Install/update CLIs on Win/Linux/macOS |
| 12 | `2026-09-17-12-token-metrics-all-agents.md` | 10 rec. | HUD + usage for Gemini and every CLI |
| 11 | `2026-09-17-11-provider-apis.md` | 9 | Anthropic / OpenAI / Gemini keys |
| 1 | `2026-09-17-01-task-handoff-mcp-skills.md` | current Task Board | Attach `.md`; pick MCP/skills per task |
| 2 | `2026-09-17-02-skills-mcp-marketplace.md` | MCP panel | Install skills and MCP from one area |
| 4 | `2026-09-17-04-project-harness-rag.md` | NewProjectModal | Folder-required projects with harness + RAG |
| 7 | `2026-09-17-07-opaque-model-router.md` | 9, 11, 10 rec. | Auto without model picker |
| 3 | `2026-09-17-03-visual-refresh.md` | — | Readable icons, stronger type |
| 5 | `2026-09-17-05-github-source-control.md` | 3 rec. | Commit/push/PR closer to VS Code SCM |
| 6 | `2026-09-17-06-ide-workbench.md` | 4, 5 | Editor + Open VSX subset |
| 8 | `2026-09-17-08-canvas-beta.md` | 1, 2, 4, 7 | Beta Flows tab (n8n-like) |

## Definition of done (program)

- [ ] P01–P12 each have a green unit test slice and CHANGELOG `[Unreleased]` notes
- [ ] `.claude/memory/CONTEXT.md` updated after every shipped plan
- [ ] No vscode fork in the tree
- [x] No OmniRoute / OpenRouter / 9router in product code
- [ ] Creating a project without a folder is impossible
- [ ] Auto/Task Board runs without requiring a model picker
- [ ] CLI install and update work on Windows, Linux, and macOS
- [ ] Users can save Anthropic, OpenAI, and Gemini API keys
- [ ] Token HUD and usage widgets cover every coding CLI, not only Claude
- [ ] Flows tab behind a Beta badge

## Execution handoff

Implement only the plan the owner names. Default next slice after this addendum: **P09**, then **P10**.
