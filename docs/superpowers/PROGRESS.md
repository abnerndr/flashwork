# Flashwork IDE program — execution progress

Last updated: 2026-09-18

Resume here if the session context runs out. Implement **one numbered plan at a time**. Default order: **P09 → P10 → P12 → P11 → P01 → P02 → P04 → P07 → P03 → P05 → P06 → P08**.

Owner (2026-09-17): after each numbered plan, **commit and merge locally to `master`**. Do not push. Do not pause for merge/PR options. The owner will review after **all** remaining plans. Do **not** stop or restart `tauri dev` / Vite. i18n in `en.ts` and `pt-BR.ts`. English in versioned source.

## Shipped (on local `master`, not pushed)

| Plan | Commit | Status |
| --- | --- | --- |
| P09 Remove OmniRoute | `9a18cbc` | done |
| P10 CLI install/update | `b3bdd6f` | done |
| P12 Token metrics all agents | `89c9746` | done (Task 6 skipped — P11 was not shipped yet) |
| P11 First-party provider APIs | `0e0a2fd` | done |

## Current slice

**Plan:** P01 — `docs/superpowers/plans/2026-09-17-01-task-handoff-mcp-skills.md`  
**ADR:** `.claude/adr/008-task-handoff-and-tool-picker.md`  
**Branch:** start `feat/p01-task-handoff-mcp-skills` from `master`  
**Status:** not started.

## After P01

Start P02 (`docs/superpowers/plans/2026-09-17-02-skills-mcp-marketplace.md`).

## P11 notes (for later slices)

- Preferences → Providers stores Anthropic / OpenAI / Gemini keys in the OS keyring (`flashwork.provider.<id>`). Keys never return to the WebView.
- CLI injection is opt-in via `useAnthropicKeyOnCli` / `useOpenaiKeyOnCli` / `useGoogleKeyOnCli` and only on `spawn_pty` / `restart_pty`. Task Board `run_planner_cli` and Codex app-server still spawn without that injection (follow-up).
- `provider_chat` and `provider_catalog_refresh` call official vendor HTTPS only. HTTP 401 → `provider_unauthorized`. Timeouts: 2500 ms router, 120 s coding.
- Effective catalog picker for P07: `pickEffectiveRouterModel` in `apps/orchestrator/src/lib/providers/catalogOverlay.ts` (not `pickRouterModel` on the static snapshot).
- Environment may append `Co-authored-by: Cursor` on commits; same as P09–P12.
