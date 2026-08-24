# Shared session context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Do not commit or open a PR** unless the owner asks. This plan was written under an explicit no-commit instruction.

**Goal:** One canonical Claude session per Auto run, shared with sibling Claudes via `--resume` + a writer lock, and with every other CLI via a local chunk index that costs zero model tokens to build.

**Architecture:** Parse the Claude JSONL on disk into small extractive chunks and a lexical index under `runs/<runId>/context/`. First prompts become pointers, not capsules. Handoff writes the same hub. A mutex replaces “claimed → mint a new Claude session” inside a run.

**Tech Stack:** TypeScript (Zustand, Vitest), Rust/Tauri (`prompt_run.rs`, `handoff.rs`, `claude_sessions.rs`), on-disk JSON/Markdown, no embedding API.

**Spec:** `docs/superpowers/specs/2026-08-24-shared-session-context-design.md`

---

## File map

| File | Responsibility |
|---|---|
| `src-tauri/src/context_hub.rs` | Chunk, index, incremental JSONL ingest, search (new) |
| `src-tauri/src/prompt_run.rs` | Persist hub paths next to journal/board |
| `src-tauri/src/handoff.rs` | Emit chunks instead of one capsule |
| `src-tauri/src/lib.rs` | Register commands |
| `src/lib/types.ts` | `canonicalClaudeSessionId`, `contextDir` on `PromptRun` |
| `src/lib/sessionDiscovery.ts` | Run-scoped claim / wait instead of fresh writer |
| `src/lib/promptRun/claudeWriterLock.ts` | Mutex helper (new) |
| `src/lib/promptRun/bootstrapPrompt.ts` | Pointer bootstrap |
| `src/lib/promptRun/startPromptRun.ts` | Reuse canonical Claude id on Claude lanes |
| `src/lib/promptRun/executeHandoff.ts` | Pointer + `contextDir`, no 48k `initialInput` |
| `src/hooks/usePromptRunWatcher.ts` | Refresh hub on PTY data (debounced) |
| `src/components/XTermView/useXtermSession.ts` | Honor lock; resume same id |
| `src/lib/tauri/contextHub.ts` | `invoke` wrappers (new) |

---

### Task 1: Chunk + lexical index (zero model tokens)

**Files:**
- Create: `apps/orchestrator/src-tauri/src/context_hub.rs`
- Create: `apps/orchestrator/src/lib/promptRun/contextChunks.ts` (pure TS mirror for unit tests of the chunk policy, or test Rust via `cargo test`)
- Test: `apps/orchestrator/src/lib/promptRun/contextChunks.test.ts`
- Modify: `apps/orchestrator/src-tauri/src/lib.rs` (add `mod context_hub`)

Chunk policy (must match spec):

```typescript
export type ContextChunk = {
  id: string
  source: 'claude' | 'codex' | 'journal'
  sessionId: string
  kind: 'user' | 'assistant' | 'tool' | 'files'
  files: string[]
  turn: number
  text: string
}

export const CHUNK_CHAR_CAP = 4000

export function splitExtractiveChunks(
  events: Array<{ role: ContextChunk['kind']; text: string; files: string[] }>,
  sessionId: string,
  source: ContextChunk['source'],
): ContextChunk[] {
  const chunks: ContextChunk[] = []
  let bucket: typeof events = []
  let files = new Set<string>()
  let turn = 0
  const flush = () => {
    if (bucket.length === 0) return
    const text = bucket.map((event) => event.text).join('\n\n')
    chunks.push({
      id: String(chunks.length + 1).padStart(4, '0'),
      source,
      sessionId,
      kind: bucket[0]?.role ?? 'user',
      files: [...files],
      turn,
      text: text.slice(0, CHUNK_CHAR_CAP),
    })
    bucket = []
    files = new Set()
    turn += 1
  }
  for (const event of events) {
    const sameFiles =
      event.files.length > 0 &&
      event.files.every((file) => files.size === 0 || files.has(file))
    const nextSize = bucket.map((item) => item.text).join('\n\n').length + event.text.length
    if (bucket.length > 0 && (!sameFiles || nextSize > CHUNK_CHAR_CAP)) flush()
    bucket.push(event)
    for (const file of event.files) files.add(file)
  }
  flush()
  return chunks
}

export function searchChunks(
  chunks: ContextChunk[],
  query: { file?: string; terms: string[] },
  byteBudget = 8192,
): ContextChunk[] {
  const scored = chunks
    .map((chunk) => {
      const fileHit = query.file && chunk.files.some((file) => file.replace(/\\/g, '/') === query.file)
      const termHits = query.terms.filter((term) =>
        chunk.text.toLowerCase().includes(term.toLowerCase()),
      ).length
      return { chunk, score: (fileHit ? 10 : 0) + termHits + chunk.turn / 1000 }
    })
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score)
  const picked: ContextChunk[] = []
  let used = 0
  for (const row of scored) {
    if (used + row.chunk.text.length > byteBudget) break
    picked.push(row.chunk)
    used += row.chunk.text.length
  }
  return picked
}
```

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, it } from 'vitest'
import { CHUNK_CHAR_CAP, searchChunks, splitExtractiveChunks } from './contextChunks'

describe('splitExtractiveChunks', () => {
  it('keeps turns that touch the same file in one chunk', () => {
    const chunks = splitExtractiveChunks(
      [
        { role: 'user', text: 'fix auth', files: ['src/auth.ts'] },
        { role: 'assistant', text: 'editing login', files: ['src/auth.ts'] },
      ],
      'sess-1',
      'claude',
    )
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.files).toEqual(['src/auth.ts'])
    expect(chunks[0]?.text).toContain('fix auth')
  })

  it('splits when the char cap would be exceeded', () => {
    const chunks = splitExtractiveChunks(
      [
        { role: 'user', text: 'a'.repeat(CHUNK_CHAR_CAP - 10), files: ['a.ts'] },
        { role: 'user', text: 'next', files: ['a.ts'] },
      ],
      'sess-1',
      'claude',
    )
    expect(chunks.length).toBeGreaterThanOrEqual(2)
  })
})

describe('searchChunks', () => {
  it('prefers file hits and stays inside the byte budget', () => {
    const chunks = splitExtractiveChunks(
      [
        { role: 'user', text: 'auth work', files: ['src/auth.ts'] },
        { role: 'user', text: 'unrelated ui', files: ['src/ui.ts'] },
      ],
      'sess-1',
      'claude',
    )
    const found = searchChunks(chunks, { file: 'src/auth.ts', terms: ['auth'] }, 8192)
    expect(found[0]?.files).toContain('src/auth.ts')
    expect(found.some((chunk) => chunk.files.includes('src/ui.ts'))).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/promptRun/contextChunks.test.ts` from `apps/orchestrator`  
Expected: FAIL resolving `./contextChunks`

- [ ] **Step 3: Implement `contextChunks.ts` with the code above**

- [ ] **Step 4: Run tests**

Expected: PASS

- [ ] **Step 5: Port the same rules into `context_hub.rs`** (`split_extractive_chunks`, `search_chunks`) with `#[cfg(test)]` covering the same two behaviors. Write `manifest.json` + `chunks/NNNN.md` + `index.json` under a temp dir. Do not call any HTTP API.

---

### Task 2: Persist hub paths on the run

**Files:**
- Modify: `apps/orchestrator/src/lib/types.ts` (`PromptRun`)
- Modify: `apps/orchestrator/src-tauri/src/prompt_run.rs` (serde record + `context` dir next to journal)
- Modify: `apps/orchestrator/src/lib/tauri/promptRun.ts` and new `apps/orchestrator/src/lib/tauri/contextHub.ts`
- Modify: `apps/orchestrator/src-tauri/src/lib.rs` invoke_handler

```typescript
export type PromptRun = {
  id: string
  projectId: string
  cwd: string
  prompt: string
  status: PromptRunStatus
  activeAgent: AgentType
  activeTerminalId: string
  unrestricted: boolean
  steps: PromptRunStep[]
  journalPath: string
  contextDir?: string
  canonicalClaudeSessionId?: string
  canonicalClaudeTerminalId?: string
  createdAt: number
}
```

Tauri commands:

```rust
#[tauri::command]
pub async fn ingest_run_context(
    app: AppHandle,
    run_id: String,
    source: String,
    session_id: String,
    cwd: String,
) -> Result<String, String> { /* parse JSONL, write hub, return context dir */ }

#[tauri::command]
pub async fn search_run_context(
    app: AppHandle,
    run_id: String,
    file: Option<String>,
    terms: Vec<String>,
) -> Result<Vec<String>, String> { /* return chunk ids in budget */ }
```

- [ ] **Step 1: Failing test** that `startPromptRun` result includes `contextDir` ending in `runs/<id>/context` after ingest (mock ingest in TS first if easier).

- [ ] **Step 2: Wire `contextDir` on `PromptRun` and create the empty hub directory when the run starts** (`prompt_run.rs`, same `runs/` root as `append_prompt_run_journal_inner`).

- [ ] **Step 3: `ingest_run_context` reads the Claude JSONL using the same path resolver as `handoff.rs` `resolve_source_file`.** Incremental: store `runs/<id>/context/cursor.json` `{ "byteOffset": n }` and only parse new bytes.

---

### Task 3: Canonical Claude session (no duplicate JSONL)

**Files:**
- Create: `apps/orchestrator/src/lib/promptRun/claudeWriterLock.ts`
- Test: `apps/orchestrator/src/lib/promptRun/claudeWriterLock.test.ts`
- Modify: `apps/orchestrator/src/lib/promptRun/startPromptRun.ts`
- Modify: `apps/orchestrator/src/lib/sessionLaunch.ts` (already supports `--resume` when `sessionId` is set)

```typescript
export type ClaudeWriterLock = {
  runId: string
  sessionId: string
  ownerTerminalId: string | null
}

const locks = new Map<string, ClaudeWriterLock>()

export function rememberCanonicalClaude(runId: string, sessionId: string): void {
  const current = locks.get(runId)
  if (current) return
  locks.set(runId, { runId, sessionId, ownerTerminalId: null })
}

export function tryAcquireClaudeWriter(runId: string, terminalId: string): 'acquired' | 'wait' | 'missing' {
  const lock = locks.get(runId)
  if (!lock) return 'missing'
  if (lock.ownerTerminalId && lock.ownerTerminalId !== terminalId) return 'wait'
  locks.set(runId, { ...lock, ownerTerminalId: terminalId })
  return 'acquired'
}

export function releaseClaudeWriter(runId: string, terminalId: string): void {
  const lock = locks.get(runId)
  if (!lock || lock.ownerTerminalId !== terminalId) return
  locks.set(runId, { ...lock, ownerTerminalId: null })
}

export function canonicalClaudeSessionId(runId: string): string | undefined {
  return locks.get(runId)?.sessionId
}
```

- [ ] **Step 1: Tests**

```typescript
it('lets the first Claude lane create the session and the second resume it', () => {
  rememberCanonicalClaude('run1', 'sess-a')
  expect(tryAcquireClaudeWriter('run1', 'term-1')).toBe('acquired')
  expect(tryAcquireClaudeWriter('run1', 'term-2')).toBe('wait')
  releaseClaudeWriter('run1', 'term-1')
  expect(tryAcquireClaudeWriter('run1', 'term-2')).toBe('acquired')
  expect(canonicalClaudeSessionId('run1')).toBe('sess-a')
})
```

- [ ] **Step 2: In `launchPromptRunLanes`, when `lane.agent === 'claude'`:**
  - if `canonicalClaudeSessionId` is unset, create the terminal as today (`--session-id` uuid) then `rememberCanonicalClaude` + patch the run
  - if set, pass `sessionId: canonical` into `firstTab` / launch args so `buildAgentLaunch` emits `--resume`

Today `CreateAgentTerminal` does not take `sessionId`. Extend `firstTab`:

```typescript
firstTab: {
  type: AgentType
  cwd: string
  extraArgs?: string[]
  initialInput?: string
  sessionId?: string
}
```

Thread it through `terminalFactory.ts` → sub-tab `sessionId` so `useXtermSession` resumes.

- [ ] **Step 3: Change `useXtermSession.ts` claim conflict** (the block that logs `session is already claimed; starting a fresh writer`): if the tab belongs to a PromptRun whose `canonicalClaudeSessionId === resumeId`, **do not** clear resume. Return wait overlay / retry acquire instead of minting a new session.

---

### Task 4: Pointer bootstrap (kill the dump)

**Files:**
- Modify: `apps/orchestrator/src/lib/promptRun/bootstrapPrompt.ts`
- Test: `apps/orchestrator/src/lib/promptRun/bootstrapPrompt.test.ts`
- Modify: `apps/orchestrator/src/lib/promptRun/startPromptRun.ts`

```typescript
export function buildRunBootstrapInput(args: {
  runId: string
  prompt: string
  agent: AgentType
  role?: 'orchestrator' | 'worker'
  skillNames?: readonly string[]
  allowedFiles?: readonly string[]
  boardPath?: string
  contextDir?: string
}): string {
  const label = AGENT_TYPE_LABELS[args.agent]
  const lines = [
    `[Flashwork Auto] You are a worker (${label}) for run ${args.runId}.`,
    'Do the assigned slice. Do not paste or request the sibling transcript.',
  ]
  if (args.contextDir) {
    lines.push(
      `Shared context is on disk at "${args.contextDir}". Read manifest.json and only the chunks that match your files. The index was built locally with no API cost.`,
    )
  }
  if (args.boardPath) {
    lines.push(`Read the shared board at "${args.boardPath}" first.`)
  }
  if (args.allowedFiles && args.allowedFiles.length > 0) {
    lines.push('You may only touch these files:')
    for (const file of args.allowedFiles) lines.push(`- ${file}`)
  }
  lines.push('', args.prompt)
  return lines.join('\n')
}
```

- [ ] **Step 1: Test** `initialInput` contains `contextDir` and **does not** contain a 1k+ transcript stub. Assert `text.length < 2000` for a 40-char user prompt.

- [ ] **Step 2: Pass `contextDir` from `startPromptRun` into `buildRunBootstrapInput`.** Create the empty hub dir before launching lanes so the path is real.

---

### Task 5: Handoff writes vectors, not one capsule

**Files:**
- Modify: `apps/orchestrator/src-tauri/src/handoff.rs`
- Modify: `apps/orchestrator/src/lib/promptRun/executeHandoff.ts`
- Test: `apps/orchestrator/src/lib/promptRun/executeHandoff.test.ts`
- Modify: `apps/orchestrator/src/lib/i18n/messages/en.ts` and `pt-BR.ts` (`handoff.bootstrapPrompt`)

`materialize_agent_handoff` today writes one file under `handoffs/<id>/`. Change it to:

1. Split draft events through the same chunker as Task 1 (call `context_hub` from `handoff.rs`).
2. Write `handoffs/<id>/context/chunks/` + `manifest.json` + `index.json`.
3. Keep a tiny `README.md` (“search chunks, do not load all”).
4. Return `contextDir` (existing `contextDir` field) pointing at that folder. Deprecate requiring `contextPath` as the full dump; keep `contextPath` as `manifest.json` for compatibility.

`buildFallbackBootstrap` / capsule bootstrap:

```typescript
export function buildIndexBootstrap(contextDir: string, prompt: string, note?: string): string {
  const prefix = note?.trim() ? `${note.trim()}\n\n` : ''
  return `${prefix}Shared context is at "${contextDir}". Read manifest.json, then only matching chunks. Continue:\n\n${prompt}`
}
```

- [ ] **Step 1: Test** `executeAutoHandoff` `initialInput` includes `manifest.json` and is shorter than 1500 chars when `prompt` is short. Must **not** include the full capsule body.

- [ ] **Step 2: Change `handoff.bootstrapPrompt`** to the pointer wording (EN + pt-BR).

- [ ] **Step 3: `--add-dir` already uses `handoff.contextDir` in `TerminalPane/index.tsx`.** Keep it; ensure `contextDir` is the hub root.

---

### Task 6: Live ingest so siblings see new Claude turns without a new dump

**Files:**
- Modify: `apps/orchestrator/src/hooks/usePromptRunWatcher.ts`
- Modify: `apps/orchestrator/src/lib/promptRun/autoHandoffGate.ts` only if ingest must be deduped

Debounce 800ms on PTY data for the canonical Claude terminal, then `ingest_run_context`. No chat API.

- [ ] **Step 1: Extract `shouldIngestContext(run, sourceTerminalId, chunk)`** — true when the step’s agent is `claude` and `run.canonicalClaudeSessionId` is set.

- [ ] **Step 2: Test that function** (pure). Wire the hook to invoke ingest; swallow errors with `console.warn`.

---

### Task 7: Auto lanes use one Claude + index for everyone else

**Files:**
- Modify: `apps/orchestrator/src/lib/promptRun/startPromptRun.ts`
- Modify: `apps/orchestrator/src/lib/promptRun/planAutoLanes.ts` (do not emit two `agent: 'claude'` workers)
- Test: `apps/orchestrator/src/lib/promptRun/startPromptRun.test.ts`

- [ ] **Step 1: Test** two-step run with `lanes: [claude implement, codex mechanical]`:
  - `createAgentTerminal` first call `firstTab.type === 'claude'` and no resume id (create)
  - after patch, second Claude lane (if any) would resume — for this test, Codex second call `initialInput` includes `context/` and length `< 2000`
  - `run.canonicalClaudeSessionId` is set after the first Claude spawn (may need the factory to echo `sessionId` from launch; if the factory does not return it, persist from `buildAgentLaunch` in `projectsStore.createAgentTerminal`)

`createAgentTerminal` currently returns `{ id }`. Extend to `{ id: string; sessionId?: string }` **only if** launch created/resumed Claude, so `startPromptRun` can `rememberCanonicalClaude`.

- [ ] **Step 2: `planAutoLanes` assertion** — at most one worker with `agent === 'claude'`. Extra Claude demand is queued on that session, not a second lane.

---

### Task 8: Changelog + FEATURES (when implementing, not during planning)

**Files:**
- Modify: `apps/orchestrator/docs/CHANGELOG.md` under `[Unreleased]` **Changed**
- Modify: `apps/orchestrator/docs/FEATURES.md` Resume / Auto bullets

User-facing text (implement later):

- Auto keeps a single Claude Code conversation per run. Other CLIs read small on-disk context chunks instead of receiving a pasted transcript. Handoff uses the same chunk index.

---

## Coverage vs spec

| Spec bar | Task |
|---|---|
| 0 tokens to build shared context | Task 1–2, 6 |
| Small vectors, not 48k dump | Task 1, 4, 5 |
| Quality via file-grouped extractive chunks + budgeted search | Task 1 |
| Claude siblings share one session | Task 3, 7 |
| Other CLIs consume that session from disk | Task 4, 6, 7 |
| Handoff uses the hub | Task 5 |

## Placeholder scan

No TBD. Commit steps omitted on purpose (owner: no commit / no PR).
