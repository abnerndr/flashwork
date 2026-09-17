# Flashwork IDE program — execution progress

Last updated: 2026-09-17

Resume here if the session context runs out. Implement **one numbered plan at a time**. Default order: **P09 → P10 → P12 → P11 → P01 → P02 → P04 → P07 → P03 → P05 → P06 → P08**.

Owner (2026-09-17): after each numbered plan, **commit and merge locally to `master`**. Do not push. Do not pause for merge/PR options. The owner will review after **all** remaining plans. Do **not** stop or restart `tauri dev` / Vite. i18n in `en.ts` and `pt-BR.ts`. English in versioned source.

## Current slice

**Plan:** P09 — `docs/superpowers/plans/2026-09-17-09-remove-omniroute.md`  
**ADR:** `.claude/adr/009-remove-omniroute.md` (accepted)  
**Branch:** `feat/p09-remove-omniroute` (workspace in place; not a linked worktree)  
**Status:** completed (Tasks 1–3)

| Task | Name | Status |
| --- | --- | --- |
| 1 | Stop rewriting spawn env | completed |
| 2 | Remove sidecar backend and UI | completed |
| 3 | Docs (FEATURES, CHANGELOG, CONTEXT) | completed |

## Next slice

Start P10 (`docs/superpowers/plans/2026-09-17-10-cli-install-update.md`).

## Notes

- Call sites of `resolveOmniRouteSpawnEnv` included files not listed in the P09 plan: `GhosttySurface/index.tsx`, `ClaudeHistoryModal.tsx`, `ProjectSidebar/sidebarMenus.tsx`.
- Preference keys `omniRouteEnabled` / `omniRouteBaseUrl` / `omniRouteCaveman` dropped in Task 2 with projects.json migration.
- Minor leftover: OS keyring may still hold `service=flashwork` / `user=omniroute-gateway` for users who saved a gateway key (no product command deletes it).
