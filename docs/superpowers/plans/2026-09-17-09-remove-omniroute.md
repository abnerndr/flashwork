# Remove OmniRoute / 9router — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the OmniRoute (9router) gateway so agents use vendor CLIs and first-party APIs only. There is no OpenRouter code in this repo; this plan removes the in-app stand-in.

**Architecture:** Strip spawn-env rewrite, sidecar Tauri commands, Home wizard, preferences, and tests. After this, `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` are never set by Flashwork.

**Tech Stack:** Existing Tauri/React modules listed below.

**ADR:** `.claude/adr/009-remove-omniroute.md`

Paths relative to `apps/orchestrator/` unless noted.

---

## File map (delete or unwind)

| File | Action |
| --- | --- |
| `src/lib/flashwork/omniroute.ts` | Delete |
| `src/lib/flashwork/omniroute.test.ts` | Delete |
| `src/lib/flashwork/omniRouteSpawn.ts` | Delete |
| `src/lib/flashwork/omniRouteSpawn.test.ts` | Delete |
| `src/lib/tauri/omnirouteSidecar.ts` | Delete |
| `src-tauri/src/omniroute.rs` | Delete |
| `src/lib/flashwork/sidecarInstall.ts` | Remove `9router` entry or delete file if unused |
| `src/components/RouterStatus/` | Delete |
| Preferences `IntegrationsPage.tsx` OmniRoute block | Remove |
| Home OmniRoute wizard (search `omni.` i18n keys) | Remove |
| `src/lib/i18n/messages/en.ts` + `pt-BR.ts` `omni.*` | Remove keys |
| `docs/FEATURES.md` OmniRoute section | Remove |
| `src-tauri/src/lib.rs` omniroute commands | Unregister |
| Call sites of `resolveOmniRouteSpawnEnv` | Pass through original env |

Known call sites from the 2026-09-17 tree:

- `src/components/TerminalPane/index.tsx`
- `src/components/modals/RecentChatsModal.tsx`
- `src/components/XTermView/useXtermSession.ts`
- `src/components/TerminalInspector/index.tsx`
- `src/stores/projectsStore.projectSlices.ts`
- `src/lib/resetLastSession.ts`
- `src/lib/ghosttyCommand.ts` (comment + env)

Preferences fields `omniRouteEnabled`, `omniRouteBaseUrl`, `omniRouteCaveman` must drop from the persisted schema with a migration that ignores unknown keys (existing projects.json versioning).

---

### Task 1: Stop rewriting spawn env

- [x] **Step 1: Failing test** — keep `omniRouteSpawn.test.ts` until behavior is “env unchanged”, then delete it

Replace tests with a single helper test if a passthrough helper remains; otherwise assert call sites no longer import OmniRoute.

- [x] **Step 2: At every `resolveOmniRouteSpawnEnv(...)` site, use the previous `base` env only**
- [x] **Step 3: Delete `omniRouteSpawn.ts` and tests once grep is clean**

Run: `rg OmniRoute\\|omniRoute\\|9router\\|omniroute src src-tauri`  
Expected: no product matches (docs/CHANGELOG historical notes may remain until Task 3)

---

### Task 2: Remove sidecar backend and UI

- [x] **Step 1: Unregister `omniroute_*` commands in `src-tauri/src/lib.rs`; delete `omniroute.rs`**
- [x] **Step 2: Delete `RouterStatus`, sidecar install catalog entry, Integrations OmniRoute toggles, Home install wizard**
- [x] **Step 3: Remove `omni.*` i18n keys from `en.ts` and `pt-BR.ts` (build fails if a leftover `t('omni…')` remains)**
- [x] **Step 4: Drop preference keys in the projects.json migration** (`omniRouteEnabled` etc. ignored)

---

### Task 3: Docs

- [x] **Step 1: Remove OmniRoute section from `docs/FEATURES.md`**
- [x] **Step 2: CHANGELOG `[Unreleased]` Removed: OmniRoute / 9router sidecar. Agents use vendor CLIs or provider API keys.**
- [x] **Step 3: Update `.claude/memory/CONTEXT.md` after ship**

---

## Coverage check

| Requirement | Task |
| --- | --- |
| Remove OpenRouter-class gateway | 1–2 (OmniRoute/9router) |
| Users keep CLIs | unchanged spawn besides env |
| No replacement proxy | ADR 009 |
