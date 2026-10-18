# Shared session context — Phase 2 design

Date: 2026-08-24
Status: implemented

## Non-negotiable bar

1. Siblings share context **without paying the API to copy a transcript**.
2. Handoff is **small on-disk vectors** (chunks + local index), not one 48 KB capsule dumped into the first prompt.
3. API context stays small **without dropping quality**: retrieve the relevant slice, not the whole history.
4. **Claude owns one canonical session per Auto run.** Every sibling Claude resumes that session. Every other CLI consumes that session from disk. No second Claude conversation. No “paste the JSONL into Codex”.

Anything that injects the full history into a new model turn fails this bar.

## What is impossible, and the substitute that still hits the bar

Claude Code and Codex cannot attach to the same live composer. Two Claude Code processes cannot both write the same `sessionId` (the claim registry already exists because a second writer corrupts or races the JSONL).

The substitute that still shares **the Claude session**:

- **One writer.** One PTY, one `claudeSessionId`, one JSONL.
- **Claude siblings** take a **writer lock** and `--resume` that same id. They never call `--session-id` with a new UUID for the same run.
- **Non-Claude siblings** never impersonate the Claude session. They read a **local index** of that JSONL. Building the index uses zero model tokens. Their first prompt is a pointer, not a dump.

Parallelism: Codex/Gemini/OpenCode keep their own processes. Claude work in the same run is serialized on the canonical session so the cache prefix stays warm and history is never duplicated.

## Token budget (hard)

| Action | Model tokens |
|---|---|
| Parse Claude/Codex JSONL, chunk, invert locally | **0** |
| Sibling bootstrap (role + index path + slice, ≤ ~400 chars) | tiny, one shot |
| Sibling retrieves chunk `003.md` via Read/tool | only that chunk |
| Second Claude `--resume` same session | **0 extra history copy**; next turn uses the existing conversation + provider cache |
| Old handoff capsule (48k chars in `initialInput`) | **forbidden** |

Quality comes from **extractive** chunks (real user/tool text, grouped by files touched), not from an LLM summary (summaries spend tokens and drift).

## Architecture

```
                    ┌─────────────────────────────────────┐
                    │  Canonical Claude session (1 writer) │
                    │  PTY + JSONL + writer mutex          │
                    └──────────────┬──────────────────────┘
                                   │ fs watch (local)
                                   ▼
                    ┌─────────────────────────────────────┐
                    │  Context hub (per Auto run)          │
                    │  runs/<runId>/context/               │
                    │    manifest.json                     │
                    │    chunks/0001.md …                  │
                    │    index.json  (lexical BM25/FTS)    │
                    └──────────────┬──────────────────────┘
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
     Claude sibling         Codex / Gemini         Handoff target
     --resume same id       pointer + search       pointer + search
     (lock, no new JSONL)   0 dump                 0 dump
```

### Context hub on disk

Path: `{profile}/runs/{runId}/context/` (same root as today’s journal/board in `prompt_run.rs`).

`chunks/NNNN.md` — one vector. Frontmatter:

```yaml
---
id: 0003
source: claude
sessionId: <canonical>
kind: user | assistant | tool | files
files: [src/auth.ts]
turn: 4
bytes: 1204
---
```

Body is the extractive text, clipped per chunk (target 800–1500 tokens equivalent, hard cap ~4 KB). Adjacent turns that touch the **same files** stay in one chunk so quality does not fragment.

`manifest.json` lists ids, files, kinds, byte sizes. No model-written synopsis.

`index.json` is a local inverted index (term → chunk ids) plus file-path posting lists. No embedding API. Optional later: local embeddings behind a flag; v1 quality uses BM25 + file filter + recency.

### Writer mutex

Replace “if claimed, start a fresh writer” (`useXtermSession.ts` today) **inside an Auto run** with:

- claimed + same `run.canonicalClaudeSessionId` → **queue**, do not mint a new session
- claimed + different run → keep today’s “fresh writer” (do not steal another project’s chat)

Queue: the second Claude pane is created, marked `waiting-for-session`, and receives the same `sessionId`. Spawn uses `--resume` only when `tryAcquireClaudeWriter(runId)` succeeds. Release on PTY exit / slice done / user Stop.

### Bootstrap (first prompt)

Workers get **no transcript**. Example:

```
[Flashwork Auto] Worker (Codex) for run {id}. Own only the tests slice.
Shared context is on disk (not in this message): {abs}/context/manifest.json
Search chunks by file or term before rereading the repo. Do not ask the user to paste history.
```

Handoff bootstrap becomes the same pointer. `prepare_agent_handoff` writes chunks into the hub (or a handoff-scoped hub) instead of one capsule file. `--add-dir` points at `context/` so Claude can Read freely; other CLIs get the absolute path in the short prompt.

### Claude session identity

On the first Claude lane of a run:

1. `buildAgentLaunch('claude', …)` may still create the id (`--session-id` uuid) **once**.
2. Persist `PromptRun.canonicalClaudeSessionId` + `canonicalClaudeTerminalId`.
3. Every later Claude lane of that run passes that id as `sessionId` so launch is `--resume`, never a second `--session-id`.

`registerSessionClaim` stays, but the owner is the **run**, not an accidental second conversation.

### Non-Claude “sharing the Claude session”

They share it **as a dataset**, not as a process:

- Watcher tails the canonical JSONL (reuse `claude_sessions` path resolution from `handoff.rs`).
- Incremental chunk append (only new lines since last offset) — 0 tokens.
- Sibling already running can Read new chunks without a new handoff turn.

### Quality without a fat window

Retrieval order for a sibling that needs context on `src/auth.ts`:

1. Chunks whose `files` contain that path (newest first)
2. Latest user-turn chunk
3. Stop after a byte budget (e.g. 8 KB) unless the agent Reads more

The model chooses reads. Flashwork does not pre-load 48 KB.

## Out of scope

- Training or uploading transcripts to a hosted vector DB
- LLM-generated summaries of the run
- Two simultaneous Claude writers on one `sessionId`
- Changing provider billing / prompt-cache internals beyond using one stable Claude session

## Success checks

- Two Claude panes in one Auto run → **one** JSONL id on disk.
- Codex sibling `initialInput` length stays under ~1 KB and contains the context dir, not the transcript.
- Handoff materialize writes `chunks/` + `index.json`; no single file ≥ 16 KB required to start work.
- Index refresh after a Claude turn does not call any chat/completions API.
- Writer lock: second Claude waits or resumes; it does not log “claimed; starting a fresh writer” for that run.
