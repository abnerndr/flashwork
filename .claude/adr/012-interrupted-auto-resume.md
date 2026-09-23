# ADR 012 — Continuity after quit/crash via disk ledger + Auto resume

- Status: accepted
- Date: 2026-09-23
- Tags: pty, prompt-run, continuity, auto
- Related: [ADR 001](001-local-first-orchestrator.md), [ADR 011](011-withdraw-in-app-ide.md)

## Context

Flashwork owns real PTYs for coding CLIs. On quit, crash, or reboot those processes die (`kill_all_sessions_background`). There is no grace period that keeps a CLI process alive across an OS reboot. Earlier product copy claimed PTYs “survive restart”; that was wrong for live processes.

Users still need continuity for Auto and Task Board work that was mid-flight. Continuity must be **metadata + scrollback + CLI session IDs + a PromptRun ledger**, not live reattach.

## Decision

1. **PTY cannot survive reboot.** Do not invent a daemon or try to reattach a dead process.
2. Persist PromptRuns with status `interrupted`, fields `interruptedAt` and `interruptReason` (`quit` | `orphan-pty` | `unclean-exit`).
3. On hydrate, if a run was `running`/`handing-off` and its terminals are gone, mark `interrupted` (not silent `cancelled`).
4. On clean quit, mark active runs `interrupted` with reason `quit` before killing PTYs.
5. Offers last **7 days** from `interruptedAt`; then expire to `cancelled`.
6. Boot offers **Resume in Auto** / **Discard**. Resume starts a fresh `submitAutoPromptRun` with the original prompt plus a journal pointer.
7. Task Board cards linked to an interrupted run move to `blocked` with `needsResume` and a resume CTA.
8. CLI pane resume (`--resume` / `sessionId` + scrollback) remains the manual terminal path; the default post-interrupt offer is Auto.

## Consequences

- Hydrate no longer cancels dead active runs in silence.
- CONTEXT and docs must not claim live PTYs survive restart.
- No new SQLite store — reuse the existing prompt-run hub on disk.
