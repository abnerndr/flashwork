# First-party provider APIs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users can paste Anthropic, OpenAI, and Google Gemini API keys and use **current** models — injected into CLIs and/or called directly by Flashwork. No OpenRouter, no OmniRoute.

**Architecture:** Keyring-backed provider store. Dated model catalog with optional vendor refresh. Spawn env injection for CLIs. Small HTTP client for router (P07) and a “API agent” fallback when the CLI is missing.

**Tech Stack:** Tauri `keyring` (already a dependency), `reqwest`, Preferences UI, Vitest.

**ADR:** `.claude/adr/010-provider-apis.md`

Paths relative to `apps/orchestrator/`.

---

## File map

| File | Responsibility |
| --- | --- |
| `src/lib/providers/modelCatalog.ts` | Snapshot of current models |
| `src/lib/providers/modelCatalog.test.ts` | Cheap vs coding model ids exist |
| `src/lib/providers/envForCli.ts` | Map provider → CLI env |
| `src-tauri/src/providers.rs` | Save/load key, `provider_chat` |
| `src/lib/tauri/providers.ts` | Invoke wrappers |
| `src/components/modals/preferences/ProvidersPage.tsx` | New page |
| `src/lib/i18n/messages/en.ts` + `pt-BR.ts` | |
| CHANGELOG | |

v1 provider ids (locked): `anthropic` | `openai` | `google`.

CLI env map (locked):

```ts
export const PROVIDER_CLI_ENV: Record<ProviderId, Record<string, string>> = {
  // values filled at runtime from keyring
  anthropic: { ANTHROPIC_API_KEY: '' },
  openai: { OPENAI_API_KEY: '' },
  google: { GEMINI_API_KEY: '', GOOGLE_API_KEY: '' },
}
```

Which CLIs receive which key when the user enables “use API key with CLI”:

- anthropic → `claude`
- openai → `codex`
- google → `gemini`, `antigravity`

---

### Task 1: Catalog snapshot (no network)

Lock a **2026-09** snapshot in `modelCatalog.ts` (update names at implement time if a vendor renamed; tests only assert shape):

```ts
export type ProviderId = 'anthropic' | 'openai' | 'google'

export type ModelEntry = {
  id: string
  label: string
  role: 'router' | 'coding' | 'ui'
}

export const MODEL_CATALOG: Record<ProviderId, ModelEntry[]> = {
  anthropic: [
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku', role: 'router' },
    { id: 'claude-sonnet-4-5-20250929', label: 'Sonnet', role: 'coding' },
    { id: 'claude-opus-4-1-20250805', label: 'Opus', role: 'coding' },
  ],
  openai: [
    { id: 'gpt-5-mini', label: 'GPT-5 mini', role: 'router' },
    { id: 'gpt-5', label: 'GPT-5', role: 'coding' },
  ],
  google: [
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', role: 'router' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', role: 'coding' },
  ],
}

export function pickRouterModel(provider: ProviderId): string {
  return MODEL_CATALOG[provider].find((m) => m.role === 'router')?.id
    ?? MODEL_CATALOG[provider][0].id
}
```

If those exact ids are withdrawn when implementing, replace with whatever the vendor lists as the current Haiku/mini/Flash and Sonnet/GPT/Pro class **in the same file**, keep roles.

- [ ] **Step 1: Tests: every provider has ≥1 `router` and ≥1 `coding`**
- [ ] **Step 2: `pickRouterModel` never throws**

---

### Task 2: Keyring + masked UI

- [ ] **Step 1: Rust `provider_key_set(id, key)`, `provider_key_status(id) -> { saved: bool }` (never return the key to the WebView after save)**
- [ ] **Step 2: `provider_key_clear(id)`**
- [ ] **Step 3: Preferences **Providers** page: three rows, password input, Save, Clear, “Use this key when spawning the matching CLI” checkbox persisted in preferences (boolean, not the key)**
- [ ] **Step 4: Tests: empty key rejected; unknown provider id rejected**

---

### Task 3: Inject env on CLI spawn

- [ ] **Step 1: Helper `cliProviderEnv(agent, prefs, hasKey): Record<string, string>`**
- [ ] **Step 2: Tests**

```ts
it('injects ANTHROPIC_API_KEY for claude when enabled and key present', () => {
  expect(cliProviderEnv('claude', { useAnthropicKeyOnCli: true }, { anthropic: true })).toEqual({
    ANTHROPIC_API_KEY: 'from-backend', // or a placeholder the spawn path fills
  })
})

it('does not inject when the toggle is off', () => {
  expect(cliProviderEnv('claude', { useAnthropicKeyOnCli: false }, { anthropic: true })).toEqual({})
})
```

The actual secret is read in Rust at spawn time (do not pass the raw key through Zustand). Frontend only sends `{ useProviderKey: true, provider: 'anthropic' }` on `spawn_pty`.

- [ ] **Step 3: Wire `spawn_pty` (or the existing env merge used by terminals) to attach keyring values**
- [ ] **Step 4: Never log env keys**

---

### Task 4: Direct chat completion (for P07 and no-CLI)

- [ ] **Step 1: `provider_chat { provider, model, messages, timeoutMs }` in Rust using official HTTPS endpoints only:**
  - Anthropic `https://api.anthropic.com/v1/messages`
  - OpenAI `https://api.openai.com/v1/chat/completions`
  - Google `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
- [ ] **Step 2: Timeout 2500 ms for router role, 120 s for coding**
- [ ] **Step 3: Map HTTP 401 to `provider_unauthorized`; do not retry**
- [ ] **Step 4: Optional catalog refresh: GET each vendor models list when the user clicks Refresh; merge into local snapshot; on failure keep snapshot**

Do not call OpenRouter, Groq, or 9router.

---

### Task 5: Docs and i18n

- [ ] **Step 1: i18n `providers.*`**
- [ ] **Step 2: CHANGELOG Added: Anthropic, OpenAI, and Gemini API keys; Removed dependency on OmniRoute covered by P09**
- [ ] **Step 3: FEATURES.md short Providers section**

---

## Coverage check

| Requirement | Task |
| --- | --- |
| Use CLIs as today | 3 is opt-in |
| Use Anthropic / OpenAI / Gemini APIs | 2, 4 |
| Current models | 1, 4 refresh |
| No OpenRouter | 4 endpoints locked |
