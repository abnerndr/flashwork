# ADR 005 — Per-project folder, harness, and RAG

- Status: accepted
- Date: 2026-09-17
- Tags: projects, rag, graphify

## Context

A Flashwork project today is a row in `projects.json` with an optional `defaultCwd`. Graphify and AI Memory are optional feature flags. Auto runs use a per-run context hub. Two projects can point at the same folder; history is mostly app-profile scoped, not folder scoped.

The owner wants: each project has its own history, files, harness, and RAG. Creating a project **requires** choosing a destination folder, then writing local metadata there and running repo/bootstrap work.

## Decision

1. Creating a project **requires** a destination directory (existing folder or newly created).
2. Flashwork writes a confined project home:

   ```
   <folder>/.flashwork/
     project.json          # flashwork project id, createdAt, features
     harness/              # AGENTS.md templates, skills allowlist, MCP pointers
     rag/                  # local index (Graphify graph + optional chunk store)
     history/              # task cards, run pointers, canvas graphs for this project
   ```

3. App-profile `projects.json` remains the registry (id → folder path). The folder is the source of truth for harness/RAG/history.
4. RAG is **local**: reuse Graphify (`graphify_ensure_graph`) and the project-scoped context hub spec. No hosted embedding API by default. A later optional local embedder (e.g. Ollama) may sit behind the same `rag/` directory.
5. Two Flashwork projects must not share a `.flashwork/` directory. If the user picks a folder that already has one, offer **open existing** vs **cancel**.

## Consequences

- `NewProjectModal` blocks submit without a folder. Opening a folder that already has `.flashwork/` reuses that project id.
- Task Board cards for folder-backed projects live under `.flashwork/history/tasks/<id>.json`; profile `task-board.json` remains the fallback for older projects. Attachments and the 09-04 run hub are still profile-scoped.
- Cross-project isolation from ADR 002 still holds: never union two `.flashwork/rag` trees.
