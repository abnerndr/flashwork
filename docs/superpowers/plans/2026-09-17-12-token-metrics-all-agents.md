# Token metrics and terminal identity for all agents — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Token HUD and usage widgets show spend (tokens, USD when known, quota windows) for every coding CLI Flashwork runs — not only Claude — and every live pane is identified as the correct agent (Gemini, Codex, Copilot, …).

**Architecture:** HUD rows come from live PTYs + `AgentType`. Cost parsers plug into existing `get_session_cost`. Gemini (and later Copilot) get session snapshot modules like `claude_sessions.rs`. Quota cards join `UsageStrip` behind the same cache pattern as Claude/Codex.

**Tech Stack:** Rust (`agent_cost.rs`, new `gemini_sessions.rs`), Zustand `agentCostStore`, `UsageStrip`, Vitest + cargo test.

**ADR:** `.claude/adr/011-token-metrics-all-agents.md`

Paths relative to `apps/orchestrator/`.

---

## Why Claude-only today (evidence)

```ts
// src/stores/agentCostStore.ts
if (s.agent !== 'claude' && s.agent !== 'codex' && s.agent !== 'opencode') continue
const sessionId = s.agent === 'codex' ? s.codexSessionId
  : s.agent === 'opencode' ? s.opencodeSessionId
  : s.claudeSessionId // gemini never has this
```

```rust
// src-tauri/src/agent_cost.rs
other => return Err(format!("agente sem custo suportado: {other}"))
```

```ts
// useXtermSession.ts
const RESUMABLE_AGENTS = ['claude', 'codex', 'opencode', 'antigravity']
```

```tsx
// HomeView/UsageStrip.tsx — only ClaudeCard, CodexCard, optional AntigravityCard
```

---

## File map

| File | Responsibility |
| --- | --- |
| `src/stores/agentCostStore.ts` | All live agent PTYs; per-agent session id field |
| `src/lib/sessionResume.ts` | `geminiSessionId`, `copilotSessionId`; `savedConversationIdFor` |
| `src/components/XTermView/useXtermSession.ts` | Include gemini (copilot) in `RESUMABLE_AGENTS` |
| `src-tauri/src/agent_cost.rs` | Parsers + pricing table |
| `src-tauri/src/gemini_sessions.rs` | New: list/parse `~/.gemini` sessions |
| `src-tauri/src/lib.rs` | Register |
| `src/lib/tauri/sessions.ts` | `snapshotGeminiSessions` |
| `src/lib/tauri/usage.ts` | `getGeminiUsage` |
| `src/lib/geminiUsageCache.ts` | Mirror `claudeUsageCache.ts` |
| `src/components/HomeView/UsageStrip.tsx` | Gemini (+ OpenCode) cards |
| `src/components/TokenHud/index.tsx` | Show agent label, not only cwd |
| `src-tauri/src/cli_resolver.rs` | Aliases `gemini` / `gemini-cli`; extra npm global dirs |
| i18n + CHANGELOG | |

---

### Task 1: HUD lists every live agent pane

- [ ] **Step 1: Failing test** for a pure helper extracted from the store

```ts
// src/lib/agentCost/liveAgentSessions.test.ts
it('includes gemini panes without a session id', () => {
  const rows = selectLiveCostTargets([
    { ptyId: 'p1', alive: true, agent: 'gemini', cwd: '/repo', sessionId: undefined },
    { ptyId: 'p2', alive: true, agent: 'claude', cwd: '/repo', sessionId: 'abc' },
    { ptyId: 'p3', alive: false, agent: 'gemini', cwd: '/repo', sessionId: 'x' },
    { ptyId: 'p4', alive: true, agent: 'shell', cwd: '/repo', sessionId: undefined },
  ])
  expect(rows.map((r) => r.agent).sort()).toEqual(['claude', 'gemini'])
})
```

Live list is built from `useTerminalsStore` + the pane’s `AgentType` (from the terminal/sub-tab), **not** only `getActiveSessions()`.

- [ ] **Step 2: Implement `selectLiveCostTargets`**
- [ ] **Step 3: `refresh` still calls `getSessionCost` when `sessionId` exists; on miss or unsupported, keep `cost: null`**
- [ ] **Step 4: TokenHud row label = `{AGENT_TYPE_LABELS[agent]} · {shortCwd}`** so Gemini is not an unlabeled folder name

---

### Task 2: Pricing table beyond Claude

- [ ] **Step 1: Replace `pricing_for` substring opus/sonnet/haiku with a table**

Families (locked v1, USD per 1M tokens, update numbers from vendor pages at implement time):

| Match | input | output |
| --- | --- | --- |
| `opus` | 5 | 25 |
| `sonnet` | 3 | 15 |
| `haiku` | 1 | 5 |
| `gpt-5-mini` / `o4-mini` / `gpt-4o-mini` | use `get_model_pricing` if present else 0.4 / 1.6 |
| `gpt-5` / `gpt-4o` | 2.5 / 10 |
| `gemini-2.5-flash` / `gemini-2.0-flash` | 0.15 / 0.60 |
| `gemini-2.5-pro` | 1.25 / 10 |

If `get_model_pricing` already returns a row, prefer it over the table.

- [ ] **Step 2: cargo tests for `pricing_for("gemini-2.5-flash")` is Some**
- [ ] **Step 3: Unknown model ⇒ `cost_usd: None`, still sum tokens**

---

### Task 3: Gemini session snapshot + cost

Gemini CLI (Google) typically writes under the user home `.gemini` directory (chats / logs). At implement time, inspect a real tree **once** and lock the parser to that layout in `gemini_sessions.rs` comments.

Approach (ordered, no guessing at runtime):

1. List session files the same way `claude_sessions::project_dirs_for_cwd` does (hash of cwd if the CLI uses it; else mtime in `~/.gemini`).
2. Parse JSON/JSONL for `usageMetadata` / `tokens` / `model` fields commonly emitted by `@google/gemini-cli`.
3. If the on-disk format has no tokens, scrape the PTY log for a line matching `(\d+)\s*(input\|prompt).{0,20}(\d+)\s*(output\|candidates)` (case insensitive) — last match wins. Store on the cost entry as `source: 'pty'`.

- [ ] **Step 1: `snapshot_gemini_sessions(cwd) -> Vec<{id, mtime, size}>`**
- [ ] **Step 2: `get_session_cost("gemini", …)` uses that snapshot**
- [ ] **Step 3: `SavedSession.geminiSessionId` + `RESUMABLE_AGENTS` includes `'gemini'`**
- [ ] **Step 4: `savedConversationIdFor` returns gemini id**
- [ ] **Step 5: Tests with a fixture JSON copied into `src-tauri/tests/fixtures/gemini/`**

---

### Task 4: CLI identity — find Gemini (and friends)

`find_windows_cli_launcher("gemini")` on Unix is `which` + `~/.local/bin` + Homebrew. GUI apps miss nvm/fnm/npm-prefix.

- [ ] **Step 1: When resolving `gemini`, also try `gemini-cli`**
- [ ] **Step 2: Extra search dirs (all OSes):** `~/.nvm/versions/node/*/bin`, `~/.fnm/aliases/default/bin`, `npm prefix -g` + `/bin`, Windows `%APPDATA%\npm`
- [ ] **Step 3: cargo/vitest: alias list is `["gemini", "gemini-cli"]` for agent gemini**
- [ ] **Step 4: Same extra dirs help Copilot (`copilot`) and others; do not special-case only Claude**

This is the “cannot identify Gemini terminal” launcher half; Task 1 is the HUD half.

---

### Task 5: Usage strip — Gemini and OpenCode

- [ ] **Step 1: `get_gemini_usage`** — if the CLI has a quota command, call it; else aggregate today’s session tokens from Task 3 (show tokens spent, not a fake 5h Claude bar)
- [ ] **Step 2: `GeminiCard` in `UsageStrip` using `AgentIcon type="gemini"`**
- [ ] **Step 3: OpenCode card from existing `get_opencode_usage_summary(24)`** (cost_usd + tokens) — data already exists, unused on Home
- [ ] **Step 4: `AiUsageModal` loads Gemini + OpenCode caches in `Promise.allSettled`**
- [ ] **Step 5: i18n `widget.geminiNoUsage`, `widget.opencodeNoUsage` (OpenCode strings already exist — use them)**
- [ ] **Step 6: CHANGELOG**

Copilot quota: only add a card if a local file or `copilot` CLI subcommand returns usage in this slice; otherwise HUD row + tokens is enough.

---

### Task 6: API-path metering (P11)

When `provider_chat` returns usage in the JSON body, map to `SessionCost` and upsert `byPtyId` under a synthetic id `api:<provider>:<runId>` so Auto-without-CLI still shows spend.

- [ ] **Step 1: Helper `sessionCostFromProviderUsage(provider, model, usage)`**
- [ ] **Step 2: Unit test Anthropic `usage.input_tokens` / `output_tokens`**

Depends on P11; if P11 is not shipped, skip this task and leave a comment in `agentCostStore` — do not block Tasks 1–5.

---

## Coverage check

| Owner request | Task |
| --- | --- |
| Token metrics not only Claude | 1, 2, 3, 5 |
| Spent tokens / cost | 2, 3, 5, 6 |
| Identify Gemini (and other) terminals | 1, 4 |
