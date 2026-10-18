# Phase 2 report — the four questions (shipped)

Date: 2026-08-24
Status: implemented (matches runtime after Tasks 1–8)

This is the same four questions as the design review, answered against the code that shipped — not the plan.

## 1. How do we share between sessions?

There is **one canonical Claude session per Auto run**: one JSONL, one writer PTY, one `sessionId` (`PromptRun.canonicalClaudeSessionId`).

Share paths:

- **Claude → Claude:** the sibling does **not** get a new conversation. `launchPromptRunLanes` reuses the canonical id. `buildAgentLaunch` emits `--resume` (or `--session-id` only on first create). `useXtermSession` waits on `tryAcquireClaudeWriter` instead of minting a fresh writer for that id.
- **Claude → Codex / Gemini / OpenCode / others:** they do not attach to Claude’s process. They consume the **context hub** on disk (`runs/<runId>/context/` — `chunks/`, `manifest.json`, `index.json`), built by `ingest_run_context` from the Claude JSONL.
- **Handoff Claude↔Codex:** `materialize_agent_handoff` writes the same hub under `handoffs/<id>/context/`. `contextPath` is `manifest.json`. `--add-dir` still points at `contextDir`.

What is still not shared as a live composer: two different CLIs cannot type into one TUI. They share **the Claude session’s content**, not the process.

## 2. Can we reuse sessions without spending tokens?

**To copy history into another model: yes — that copy costs 0 model tokens.** Parsing JSONL, splitting extractive chunks (`CHUNK_CHAR_CAP = 4000`), and writing a lexical inverted index are local. No embed API, no chat/completions call to build the hub.

**The next useful turn still costs whatever that CLI’s API charges** for the tokens it actually sends (slice prompt + any chunks the agent Reads). The saving is that we **do not** pay to re-ingest ~48k of history as the first message.

Claude sibling resume: **0 tokens to duplicate the session** (there is no duplicate). The following user/slice turn is a normal Claude turn on the **same** prefix.

Watcher refresh (`shouldIngestContext` + 800 ms debounce): **0** chat API calls.

## 3. What happens to Claude sessions? Do we duplicate them?

**Duplication inside a run is refused.**

- First Claude lane: `--session-id` with a UUID minted once, then `rememberCanonicalClaude` + persist on the run.
- Any later Claude in that run: `--resume` that id, or **wait** if another pane holds the writer lock (up to 120 s).
- Claim conflict for that canonical id does **not** log `already claimed; starting a fresh writer`.
- `planAutoLanes` keeps at most one worker with `agent === 'claude'`.
- Early-exit retry on the canonical session does not force a fresh UUID.

Other CLIs never get a forged Claude session. They get files.

The writer lock is in-memory and restored from the persisted `PromptRun` on `setRun` / hydrate.

## 4. How does context pass from one session to another? Still injecting in the first prompt?

**Only a pointer is injected.**

Auto worker bootstrap (`buildRunBootstrapInput`): role, slice, absolute `contextDir`, “read `manifest.json` and only matching chunks.” Length stays under ~2k for a short user prompt.

Handoff bootstrap (`buildIndexBootstrap`): same pointer + the user prompt. Not the capsule body.

The receiving model **pulls** small vectors (chunks) with Read when it needs them. Quality is extractive (real turns + files touched), grouped by file, not an LLM summary.

Honest limits:

- `prepare_agent_handoff` still builds an internal draft from the source JSONL so the hub has text to chunk. What changed is **what lands in `initialInput`**.
- If prepare/materialize fails (or the source is not Claude/Codex), fallback is still journal path + user prompt (`buildFallbackBootstrap`).

---

## Before vs shipped

| Question | Before Phase 2 | Shipped |
|---|---|---|
| Share | Board markdown + fat first prompt; new session per pane | One Claude session + local chunk hub |
| Zero-token reuse | Resume same pane only; Auto always minted new chats | Resume canonical Claude; index is free to build |
| Claude siblings | Second pane = new JSONL (`fresh writer`) | Same JSONL, writer lock, `--resume` |
| Pass context | Inject transcript/capsule into `initialInput` | Inject path; chunks stay on disk |
