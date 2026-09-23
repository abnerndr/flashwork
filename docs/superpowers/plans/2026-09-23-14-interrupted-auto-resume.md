# P14 — Continuity after reboot/crash (ledger 7 days + Resume in Auto)

> Owner named this slice: after quit/crash, keep Auto/Task Board work offerable for 7 days and resume in Auto.

**Goal:** When Flashwork quits or crashes, active Auto / Task Board PromptRuns become `interrupted` on disk. Next boot offers Resume in Auto / Discard for up to 7 days. PTYs do not stay alive.

**ADR:** `.claude/adr/012-interrupted-auto-resume.md`

## Reality

Processes die on quit/crash/reboot. Continuity = scrollback + CLI `sessionId` + PromptRun JSON ledger. Do not invent a live-PTY reattach daemon.

## Scope

- Home Auto, PromptRunBar, Task Board cards with `runId`, Flows agent nodes via `submitAutoPromptRun`
- Reinforce existing CLI pane resume (`--resume` / sessionId)
- TTL: 7 days from `interruptedAt`
- Out of scope: keep CLI process alive; in-app IDE (ADR 011)

## Tasks

1. Types: `PromptRunStatus` + `interrupted` / `interruptedAt` / `interruptReason`; TaskCard `needsResume`; TTL helpers + unit tests.
2. Hydrate/quit: mark `interrupted` instead of silent cancel; quit `beforeClose` flushes runs + Task Board.
3. Boot modal: list offerable interrupted runs; Resume → `submitAutoPromptRun` with journal handoff; Discard → `cancelled`.
4. Task Board: `blocked` + `needsResume` CTA; i18n; CHANGELOG; CONTEXT; PROGRESS; this plan; ADR 012.

## Done when

- Unit tests cover interrupt mark, TTL, and resume prompt shape.
- Boot shows Resume/Discard for interrupted runs &lt; 7 days.
- Quit marks active runs interrupted and persists board `needsResume`.
