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

## Current slice

**Plan:** P07 — `docs/superpowers/plans/2026-09-17-07-opaque-model-router.md`  
**ADR:** `.claude/adr/006-opaque-model-routing.md` (confirm in that plan)  
**Branch:** start `feat/p07-opaque-model-router` from `master`  
**Status:** not started.

## After P07

Start P03 (`docs/superpowers/plans/2026-09-17-03-visual-refresh.md`) unless the P07 plan or owner says otherwise.

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
