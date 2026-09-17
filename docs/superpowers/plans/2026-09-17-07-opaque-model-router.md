# Opaque model router — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto, Task Board, and later Flows pick agent/kind without the developer choosing a model or staring at tokens. A cheap/free router runs first; regex `classifyTask` remains the offline fallback.

**Architecture:** New module `src/lib/promptRun/routeTask.ts` wrapping `classifyTask` + `selectAgent` + optional `provider_chat` (P11) on a cheap catalog model. OmniRoute is gone (P09).

**Tech Stack:** Existing planner (`planner.ts`, `parsePlannerSlices`), provider APIs (P11), installed CLIs (P10).

**ADR:** `.claude/adr/006-opaque-model-router.md`  
**Depends on:** P09 (no OmniRoute), P11 (keys + catalog), P10 recommended so Auto can install a missing CLI.

Paths relative to `apps/orchestrator/`.

---

## File map

| File | Responsibility |
| --- | --- |
| `src/lib/promptRun/routeTask.ts` | Orchestrate fallbacks |
| `src/lib/promptRun/routeTask.test.ts` | No network tests |
| `src/lib/promptRun/freeRouter.ts` | Probe: provider_chat cheap model, else null |
| `src/lib/tauri/providers.ts` | `provider_chat` from P11 |
| `src/lib/taskBoard/planner.ts` | Call `routeTask` instead of duplicating selectAgent |
| `src/lib/promptRun/submitAutoPromptRun.ts` | Same |
| Preferences: hide model pickers on Auto | Integrations / Task Board composer |
| Token HUD | Opt-in in preferences (default: collapsed) |

---

### Task 1: Router contract (pure)

- [ ] **Step 1: Failing tests**

```ts
import { routeTask } from './routeTask'

it('falls back to classifyTask when no remote router', async () => {
  const out = await routeTask({
    prompt: 'restyle the login modal',
    enabledAgents: ['claude', 'antigravity'],
    installedAgents: ['claude', 'antigravity'],
    claudeFiveHourUtilization: null,
    codexRateLimited: false,
    probe: async () => null,
  })
  expect(out.taskKind).toBe('ui')
  expect(out.agent).toBe('antigravity')
})

it('accepts schema-valid JSON from probe and ignores extra keys', async () => {
  const out = await routeTask({
    prompt: 'anything',
    enabledAgents: ['codex'],
    installedAgents: ['codex'],
    claudeFiveHourUtilization: null,
    codexRateLimited: false,
    probe: async () => ({ kind: 'mechanical', agent: 'codex', reason: 'tests' }),
  })
  expect(out.agent).toBe('codex')
  expect(out.taskKind).toBe('mechanical')
})

it('ignores probe agents that are not installed', async () => {
  const out = await routeTask({
    prompt: 'implement login',
    enabledAgents: ['claude'],
    installedAgents: ['claude'],
    claudeFiveHourUtilization: null,
    codexRateLimited: false,
    probe: async () => ({ kind: 'implement', agent: 'gemini', reason: 'x' }),
  })
  expect(out.agent).toBe('claude')
})
```

- [ ] **Step 2: Implement `routeTask` using `selectAgent` as fallback**
- [ ] **Step 3: Probe payload must be validated; on throw/timeout treat as null**

Timeout: 2500 ms. No retry loop.

---

### Task 2: Probe order (no gateway)

`probeInstalledAgents` already exists (`src/lib/promptRun/probeInstalled.ts`). Router probe:

1. If any provider key is saved (P11), `provider_chat` with `pickRouterModel(provider)` — first configured among `google` (cheap/fast), `openai`, `anthropic`
2. Else `null` → regex `classifyTask` + `selectAgent` on installed CLIs
3. If no CLI and no key → return a structured `needsSetup: 'cli' | 'api'` for the UI (install CTA from P10 / Providers page from P11)

Do **not** call OmniRoute, OpenRouter, Groq, or Ollama in v1.

- [ ] **Step 1: `freeProbe` uses `provider_chat` with a fake in tests**
- [ ] **Step 2: Wire `routeTask({ probe: freeProbe })` from Task Board planner and Auto submit**
- [ ] **Step 3: If result `agent` is `api:google` (etc.), spawn the direct API path from P11 instead of a PTY CLI**

---

### Task 3: Hide choice in default UX

- [ ] **Step 1: Task Board composer: no agent dropdown (planner already assigns slices)**
- [ ] **Step 2: Home Auto remains the default quick-launch chip; pinning an explicit agent stays available behind "Choose agent"**
- [ ] **Step 3: Token HUD (`TokenHud`) collapsed by default; preference `showTokenHud`**
- [ ] **Step 4: i18n + CHANGELOG** explaining that Flashwork routes UI vs architecture automatically

---

## Coverage check

| Spec requirement | Task |
| --- | --- |
| Developer does not pick best model for UI vs architecture | 1–3 |
| Cheap model via first-party API under the hood | 2 |
| Keep current Auto/selectAgent as fallback | 1 |
| No OmniRoute / OpenRouter | 2 |
