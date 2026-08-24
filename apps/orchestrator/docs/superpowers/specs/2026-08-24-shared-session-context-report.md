# Phase 2 report — the four questions (planned end state)

This answers the same four questions as before, **after** the Phase 2 implementation in
`docs/superpowers/specs/2026-08-24-shared-session-context-design.md`.
It matches the shipped behavior.

## 1. How do we share between sessions?

There is **one canonical Claude session per Auto run**: one JSONL, one writer PTY, one `sessionId`.

Share paths:

- **Claude → Claude:** the sibling does **not** get a new conversation. It `--resume`s the same id under a writer lock. That is the same session, not a copy.
- **Claude → Codex / Gemini / OpenCode / others:** they do not attach to Claude’s process. They consume the **context hub** on disk (`runs/<runId>/context/chunks` + `index.json`), built by watching the Claude JSONL locally.
- **Handoff across providers:** the same hub. No second giant markdown packet.

What is still not shared as a live composer: two different CLIs cannot type into one TUI. They share **the Claude session’s content**, not the process.

## 2. Can we reuse sessions without spending tokens?

**To copy history into another model: yes — that copy costs 0 model tokens.** Parsing JSONL and writing chunks is local.

**The next useful turn still costs whatever that CLI’s API charges** for the tokens it actually sends. The saving is that we **do not** pay to re-ingest 48k of history as the first message.

Claude sibling resume: **0 tokens to duplicate the session** (there is no duplicate). The following user/slice turn is a normal Claude turn on the **same** prefix, which is what prompt cache is for.

Index build and refresh: **0** chat/completions/embedding API calls in v1 (lexical index only).

## 3. What happens to Claude sessions? Do we duplicate them?

**We refuse duplication inside a run.**

- First Claude lane: creates the session (`--session-id` once) and stores `canonicalClaudeSessionId`.
- Any later Claude in that run: `--resume` that id, or **waits** if another pane holds the writer lock.
- We will **not** do today’s fallback “already claimed → start a fresh writer” for that canonical id.
- The original JSONL is never cloned into a second Claude conversation for siblings.

Other CLIs never get a forged Claude session. They get files.

## 4. How does context pass from one session to another? Still injecting in the first prompt?

**Only a pointer is injected.** The first prompt is: role, slice, absolute `context/` path, “read the manifest and the chunks that match your files.”

It is **not** the transcript, **not** the old handoff capsule body, **not** “continue this user request” plus the full journal.

The receiving model **pulls** small vectors (chunks) with Read/search when it needs them. That is on-demand context, not a dump. Quality is extractive (real turns + files touched), not an LLM summary.

---

## Today vs Phase 2

| Question | Today | Phase 2 target |
|---|---|---|
| Share | Board markdown + fat first prompt; new session per pane | One Claude session + local chunk hub |
| Zero-token reuse | Resume same pane only; Auto always mints new chats | Resume canonical Claude; index is free to build |
| Claude siblings | Second pane = new JSONL | Same JSONL, writer lock |
| Pass context | Inject transcript/capsule into `initialInput` | Inject path; chunks stay on disk |
