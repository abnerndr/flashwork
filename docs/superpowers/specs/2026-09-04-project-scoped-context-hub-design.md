# Project-scoped context hub — design

Date: 2026-09-04
Status: proposed
Builds on: `2026-08-24-shared-session-context-design.md` (Phase 2, implemented)

## Problem

Phase 2 shipped a per-**run** context hub (`runs/<runId>/context/`): one canonical Claude
session, writer lock, on-disk chunk index, pointer-only bootstrap. That closed sharing
*inside* one Auto run.

Three gaps remain, confirmed against real usage:

1. **Two Auto runs in the same Project don't know about each other.** Each run gets its own
   hub. Starting a second run while the first is active gives it a blank context — no
   awareness of files already touched or work already claimed.
2. **No progress signal between lanes/tasks.** `TaskBoard`'s `cardFilesConflict` /
   `filesOverlap` (`schedule.ts`) already blocks two cards from claiming overlapping
   `allowedFiles`, but only against what was **declared** at planning time — not what an
   agent actually touches once it starts working.
3. **OpenCode handoff is still expensive.** `isCapsuleProvider` (`executeHandoff.ts`) only
   recognizes `claude` and `codex`. A handoff to/from OpenCode falls back to
   `buildFallbackBootstrap` — the full run journal path plus the raw prompt — even though
   `opencode_sessions.rs` already exists on the backend and could be parsed into the same
   chunk schema.

## Scope

- Shared visibility applies **only to orchestrated flows**: Auto runs and TaskBoard tasks.
  Manually opened terminal tabs stay isolated, exactly as today.
- Sharing is scoped to one **Project**. Two different Projects never read each other's hub,
  even if they happen to point at the same repo path. This is a hard boundary, not a
  default.
- Progress signaling is **pull-based, on disk, zero model tokens** — no proactive prompt
  injection into a running agent's turn. Consumers (TaskBoard, AgentCanvas, the next
  scheduling pass) read it when they need it, the same way siblings already pull context
  chunks today.

## Non-negotiable bar (inherited from Phase 2, still holds)

1. Sharing between runs/tasks in the same Project costs **0 model tokens** to build.
2. No capsule dump. Bootstraps stay pointer-sized.
3. Cross-Project isolation is absolute — no code path may union two Projects' hubs.
4. Status/progress data is descriptive metadata for scheduling and UI, never text injected
   into a model turn.

## Architecture

Promote the hub from run-scoped to Project-scoped:

```
{profile}/projects/{projectId}/context/
  manifest.json            # chunk ids -> {runId, source, files, kind, turn} across all runs
  chunks/{runId}/NNNN.md   # chunk body, namespaced by run — no id collisions across runs
  index.json               # inverted index (term/file -> chunk ids) across the whole project
  status/
    {laneId}.json           # {runId, taskId, agent, state, filesTouched[], updatedAt}
```

`PromptRun.project_id` already exists (`prompt_run.rs`), so this is a change of root path, not
a new identity concept.

```
                 ┌───────────────────────────────────────────┐
                 │  Project context hub                       │
                 │  projects/{projectId}/context/              │
                 │    manifest.json + index.json (merged)       │
                 │    chunks/{runId}/…                          │
                 │    status/{laneId}.json                      │
                 └───────────────┬───────────────────────────┘
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
        Auto run A          Auto run B         TaskBoard task
        (this project)      (this project)     (this project)
              │                  │                  │
              └── writes chunks + status, reads manifest/status of siblings ──┘

Project X hub  ⟂  Project Y hub  — never linked, never read across.
```

### Path and lifecycle

- `ensure_prompt_run_context(runId)` becomes `ensure_project_context(projectId)`. Each run
  still gets its own chunk namespace (`chunks/{runId}/`) inside the shared hub, so concurrent
  runs never overwrite each other's chunk files.
- `context_hub.rs::ensure_hub_skeleton` gains a project-level variant. `manifest.json` and
  `index.json` become **merge targets**: a run appends its own chunk entries instead of
  overwriting the file. Write is atomic tmp→rename (same pattern as `projects.json`); on a
  write race, retry once.
- Retention: `ensure_project_context` prunes chunks/status past a size or age cap on open
  (same philosophy as today's `CHUNK_CHAR_CAP`), so a long-lived Project's hub doesn't grow
  unbounded across months of runs.

### Status ledger

- `status/{laneId}.json` is written by Flashwork itself (Rust/TS glue), not by the model —
  writing it costs no tokens and never touches a prompt.
- Written on lane/task state transitions: `working` (on start), a refresh when a new chunk
  with a `files:` entry lands for that lane, then `done` / `blocked` / `failed`.
- Shape: `{ runId, taskId, agent, state, filesTouched: string[], updatedAt }`.
- Consumers are read-only: TaskBoard's scheduler, `AgentCanvasPOC`, and the Home run
  timeline. None of them feed this back into a model prompt.

### TaskBoard scheduling change

`cardFilesConflict` (`schedule.ts`) currently checks `candidate.allowedFiles` against the
declared `allowedFiles` of busy cards. It gains a second, optional input: the live
`filesTouched` recorded in `status/*.json` for busy lanes in the same project. A card is
blocked if it overlaps **either** the declared allowlist **or** what a running lane has
actually touched so far — closing the gap where an agent drifts outside its declared scope
mid-task.

### OpenCode as a capsule provider

- `isCapsuleProvider` (`executeHandoff.ts`) adds `'opencode'`.
- Backend gains a chunk-ingestion path for OpenCode sessions (reusing the parsing already
  available via `opencode_sessions.rs`), emitting the same chunk frontmatter schema as
  Claude/Codex (`source: opencode`).
- If parsing an OpenCode session fails, behavior is unchanged from today: fall through to
  `fallbackHandoff` (journal path + prompt). No new failure mode, just a narrower window for
  hitting it.

## Data flow

1. TaskBoard plans a slice, assigns it a lane, writes `status/{laneId}.json` with
   `state: 'working'`, `filesTouched: []`.
2. The lane's agent runs. As turns land in its session log, the existing ingestion pipeline
   (unchanged from Phase 2) writes new chunks into `chunks/{runId}/` with `files:`
   frontmatter, and the project's `status/{laneId}.json` gets its `filesTouched` refreshed
   from those chunks.
3. Any other lane/task planning pass in the same project reads `status/*.json` before
   assigning new work — `cardFilesConflict` sees live files, not just the declared plan.
4. On completion/failure, the lane's status flips to `done`/`blocked`/`failed`; UI
   (TaskBoard, AgentCanvas) reflects it from the same file, no separate event needed.
5. A handoff from/to OpenCode now goes through `prepareAgentHandoff` /
   `materializeAgentHandoff` like Claude/Codex, landing chunks in the project hub instead of
   a fallback capsule.

## Error handling

| Failure | Behavior |
|---|---|
| Concurrent write to `manifest.json`/`index.json` from two runs | Atomic tmp→rename; one retry on conflict |
| `status/{laneId}.json` write fails | Logged to `spawn.log`; never raised to the agent turn — status is telemetry, not a dependency |
| OpenCode session fails to parse into chunks | Falls back to today's `fallbackHandoff` (journal + prompt) — same as any unsupported provider |
| Project hub grows unbounded over time | `ensure_project_context` prunes old chunks/status by age/size cap on open |

## Out of scope

- Sharing across manually opened terminal tabs (non-Auto, non-TaskBoard).
- Sharing across two different Projects, even pointing at the same repo path.
- Proactive push of status into a running agent's prompt.
- Any provider other than Claude/Codex/OpenCode becoming a capsule provider (future work).

## Testing

- Unit: `ensure_project_context` path builder — two runs in the same project share one root,
  write to distinct `chunks/{runId}/` subfolders.
- Unit: `schedule.test.ts` — `cardFilesConflict` blocks a candidate whose file overlaps a busy
  lane's live `filesTouched`, even when `allowedFiles` didn't declare that file.
- Unit: OpenCode fixture → `isCapsuleProvider` + ingestion produce a chunk with the same
  schema as the existing Claude/Codex fixtures.
- Integration: two Auto runs started concurrently in one project → single merged manifest, no
  corruption, both runs' chunks present.
- Integration (negative): two different Projects running Auto at the same time never see each
  other's `status/` or `manifest.json` — hub paths and reads stay fully disjoint.
- Manual: open Project 1 and Project 2 side by side, run Auto in both touching a same-named
  file, confirm zero cross-project status leakage in the UI.

## Success checks

- Starting a second Auto run in a Project that already has one running sees the first run's
  chunks and status without any extra token cost.
- A TaskBoard card is blocked from claiming a file another lane in the same project is
  actively touching, even if that file wasn't in its original `allowedFiles`.
- OpenCode handoff `initialInput` stays pointer-sized (comparable to the existing Claude/Codex
  bound), not the full journal.
- No test or manual check ever observes one Project's hub content from another Project.
