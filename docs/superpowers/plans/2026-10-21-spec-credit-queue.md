# Run SPEC credit queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a Run SPEC CLI runs out of credit, close its pane and continue that slice on a CLI that still has credit — in the same pane after the current slice finishes, or in a new pane when nobody is working.

**Architecture:** Pure decisions live in `src/lib/promptRun/creditQueue.ts` (signal, queue status, continuation text, what to do when a slice finishes). `src/lib/promptRun/specCreditActions.ts` performs those decisions against the prompt-run store, the board, the journal, and the PTY. The watcher and `noteSpecTerminalComplete` call that module. Non-SPEC Auto handoff stays on the existing 80% Claude path.

**Tech Stack:** TypeScript, Vitest, Zustand prompt-run store, existing Tauri `append_project_run_board`, `append_prompt_run_journal`, `write_pty`, and `deleteTerminal`.

## Global Constraints

- Run SPEC only. A run with `specTasks` uses this queue. A non-SPEC Auto run keeps today's handoff, including Claude at 80% five-hour utilization.
- Login and invalid-API-key failures keep today's `decideLaneFailure` path. They do not enter this queue.
- `SpecTaskStatus` is `pending | running | queued | done | failed`. `queued` means credit ran out and the slice is waiting.
- `queuedAt?: number` on `SpecTask`. Oldest `queuedAt` leaves first.
- `exhaustedAgents?: AgentType[]` on `PromptRun`, for this run only. Do not call `markAgentAuthFailed` for credit.
- A credit block closes the pane with `deleteTerminal` (that already kills the PTY). Set the slice to `queued` and clear `terminalId` before closing, so the exit cannot mark the slice `done`.
- While another coding slice is `running`, do not open a pane. When a coding CLI finishes, type the oldest queued coding slice into that same pane.
- When no coding slice is `running`, open the next eligible CLI immediately. Eligible means `specHandoffAgents` minus `exhaustedAgents` (`shell` and `gemini` stay out). Preference order is the existing `HANDOFF_PREF`.
- A shell pane never receives a coding slice.
- When no eligible CLI remains and no coding slice is `running`, every queued coding slice becomes `failed`.
- Continuation text contains only: slice id and title, the full slice prompt, the board path, the journal path when one exists, the ids of slices already `done`, and one line that the previous CLI stopped because credit ran out and this CLI must finish only this slice. Do not paste the SPEC body again.
- Write the board and journal note before closing the pane. Heading: `{id} stopped ({agent label})`. Body: `Task "{title}" stopped because credit ran out.`
- Progress remaining is `pending` + `running` + `queued`. Percent is `done / total`. A `failed` slice does not raise percent and is not remaining. Current title is the `running` slice, otherwise `pending`, otherwise `queued`. ETA formula stays `(elapsed / done) * remaining`, null when `done === 0` or `remaining === 0`.
- Credit signal, and only when lane status is not `working`: terminal text matches `429`, rate limit, quota exceeded, usage limit, out of credits, insufficient credit, or credit balance; or Codex `codexRateLimited`; or Claude five-hour utilization `>= 100`. Utilization below 100 does not enqueue. `overloaded` alone does not enqueue. A credit phrase while status is `working` does not enqueue.
- `specRunSettled` stays false while any slice is `queued`. `readySpecTasks` does not launch a `queued` slice.
- One queued slice is delivered per completion.
- Toasts, English and pt-BR, through `t()`:
  - Wait title `{agent} stopped because credit ran out` / `{agent} parou por crédito`
  - Wait body `This slice waits for the next CLI to finish.` / `A fatia espera o próximo CLI terminar.`
  - Open title `Continuing on {agent}.` / `Continuando no {agent}.`
  - Open body is the slice title
  - Fail title `No CLI with credit left to continue.` / `Nenhum CLI com crédito para continuar.`
  - Fail body `This slice failed.` / `A fatia falhou.`
- `{agent}` is `AGENT_TYPE_LABELS[agent]`, not the raw id.
- Visible strings go in `src/lib/i18n/messages/en.ts` and `src/lib/i18n/messages/pt-BR.ts`. Changelog entry under `## [Unreleased]` → `### Added` in `docs/CHANGELOG.md`.
- Do not commit, push, or add a co-author trailer unless the owner asked for commits in the execution request. When a step says Commit and the owner did not ask, skip that step.
- Do not stop or restart `tauri dev` or Vite.
- Out of scope: several SPEC attachments, CLI install, terminal glyph spacing.

---

### Task 1: Credit signal

**Files:**
- Create: `src/lib/promptRun/creditQueue.ts`
- Create: `src/lib/promptRun/creditQueue.test.ts`
- Modify: `src/lib/promptRun/detectHandoffTrigger.ts` (export `HANDOFF_PREF` only)
- Test: `src/lib/promptRun/creditQueue.test.ts`

**Interfaces:**
- Consumes: `AgentType` from `src/lib/types.ts`, `PtyStatus` from `src/lib/types.ts`
- Produces: `isCreditExhausted(input: { agent: AgentType; claudeFiveHourUtilization: number | null; codexRateLimited: boolean; ptyChunk: string; laneStatus: PtyStatus | 'unknown' }): boolean`
- Produces: exported `HANDOFF_PREF` from `detectHandoffTrigger.ts` (unchanged order)

- [ ] **Step 1: Write the failing test**

Create `src/lib/promptRun/creditQueue.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { isCreditExhausted } from './creditQueue'

const base = {
  claudeFiveHourUtilization: null as number | null,
  codexRateLimited: false,
  ptyChunk: '',
  laneStatus: 'waiting' as const,
}

describe('isCreditExhausted', () => {
  it('matches a provider refusal while the lane is waiting', () => {
    expect(isCreditExhausted({ ...base, agent: 'opencode', ptyChunk: 'Error: HTTP 429 rate limit exceeded' })).toBe(true)
    expect(isCreditExhausted({ ...base, agent: 'claude', ptyChunk: 'quota exceeded' })).toBe(true)
    expect(isCreditExhausted({ ...base, agent: 'codex', ptyChunk: 'usage limit reached' })).toBe(true)
    expect(isCreditExhausted({ ...base, agent: 'copilot', ptyChunk: 'You are out of credits' })).toBe(true)
    expect(isCreditExhausted({ ...base, agent: 'mimo', ptyChunk: 'insufficient credit balance' })).toBe(true)
  })

  it('ignores a credit phrase while the lane is still working', () => {
    expect(
      isCreditExhausted({
        ...base,
        agent: 'claude',
        laneStatus: 'working',
        ptyChunk: '429 rate limit exceeded',
      }),
    ).toBe(false)
  })

  it('treats Claude utilization of 100 as blocked and ignores 80', () => {
    expect(isCreditExhausted({ ...base, agent: 'claude', claudeFiveHourUtilization: 100 })).toBe(true)
    expect(isCreditExhausted({ ...base, agent: 'claude', claudeFiveHourUtilization: 80 })).toBe(false)
  })

  it('treats a rate-limited Codex as blocked only when the lane is not working', () => {
    expect(isCreditExhausted({ ...base, agent: 'codex', codexRateLimited: true })).toBe(true)
    expect(
      isCreditExhausted({ ...base, agent: 'codex', codexRateLimited: true, laneStatus: 'working' }),
    ).toBe(false)
  })

  it('does not treat overload, login, or a shell as credit exhaustion', () => {
    expect(isCreditExhausted({ ...base, agent: 'claude', ptyChunk: 'overloaded' })).toBe(false)
    expect(isCreditExhausted({ ...base, agent: 'claude', ptyChunk: 'Please enter an API key' })).toBe(false)
    expect(isCreditExhausted({ ...base, agent: 'shell', ptyChunk: '429 rate limit exceeded' })).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/lib/promptRun/creditQueue.test.ts`

Expected: FAIL, cannot find module `./creditQueue` or `isCreditExhausted` is not exported.

- [ ] **Step 3: Write the minimal implementation**

In `src/lib/promptRun/detectHandoffTrigger.ts`, change the preference constant to:

```ts
export const HANDOFF_PREF: AgentType[] = [
```

The array body stays as it is. `handoffTarget` keeps using it.

Create `src/lib/promptRun/creditQueue.ts`:

```ts
import type { AgentType, PtyStatus } from '../types'

const CREDIT_EXHAUSTED_PATTERN =
  /429|rate[\s-]?limit|quota exceeded|usage limit|out of credits|insufficient credit|credit balance/i

export function isCreditExhausted(input: {
  agent: AgentType
  claudeFiveHourUtilization: number | null
  codexRateLimited: boolean
  ptyChunk: string
  laneStatus: PtyStatus | 'unknown'
}): boolean {
  if (input.agent === 'shell') return false
  if (input.laneStatus === 'working') return false
  if (CREDIT_EXHAUSTED_PATTERN.test(input.ptyChunk)) return true
  if (input.agent === 'codex' && input.codexRateLimited) return true
  if (input.agent === 'claude' && input.claudeFiveHourUtilization != null && input.claudeFiveHourUtilization >= 100) {
    return true
  }
  return false
}
```

Do not change `detectHandoffTrigger`. Auto still fires Claude at 80.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run src/lib/promptRun/creditQueue.test.ts src/lib/promptRun/detectHandoffTrigger.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

Skip unless the owner asked for commits in the execution request.

```bash
git add src/lib/promptRun/creditQueue.ts src/lib/promptRun/creditQueue.test.ts src/lib/promptRun/detectHandoffTrigger.ts
git commit -m "$(cat <<'EOF'
Add a Run SPEC credit-exhausted signal that ignores an 80 percent Claude window.

EOF
)"
```

---

### Task 2: Queue decisions, continuation text, and progress

**Files:**
- Modify: `src/lib/types.ts` (`SpecTaskStatus`, `SpecTask`, `PromptRun`)
- Modify: `src/lib/promptRun/creditQueue.ts`
- Modify: `src/lib/promptRun/creditQueue.test.ts`
- Modify: `src/lib/promptRun/specProgress.ts`
- Modify: `src/lib/promptRun/specProgress.test.ts`
- Modify: `src/lib/promptRun/specPlan.test.ts`
- Test: `src/lib/promptRun/creditQueue.test.ts`, `src/lib/promptRun/specProgress.test.ts`, `src/lib/promptRun/specPlan.test.ts`

**Interfaces:**
- Consumes: `isCreditExhausted` from Task 1, `HANDOFF_PREF` from `detectHandoffTrigger.ts`, `isSpecWorkerAgent` from `specPlan.ts`, `SpecTask` from `types.ts`
- Produces:

```ts
export function withQueuedSlice(tasks: readonly SpecTask[], terminalId: string, now: number): SpecTask[]
export function withExhaustedAgent(current: readonly AgentType[] | undefined, agent: AgentType): AgentType[]
export function oldestQueuedCodingSlice(tasks: readonly SpecTask[]): SpecTask | null
export function decideCreditQueue(tasks: readonly SpecTask[], eligible: readonly AgentType[]): 'wait' | 'open' | 'fail'
export function failQueuedCodingSlices(tasks: readonly SpecTask[]): SpecTask[]
export function buildCreditContinuation(input: {
  runId: string
  task: Pick<SpecTask, 'id' | 'title' | 'prompt'>
  boardPath?: string
  journalPath?: string
  doneIds: readonly string[]
}): string
export type CreditDelivery =
  | { kind: 'type'; tasks: SpecTask[]; terminalId: string; text: string }
  | { kind: 'open'; tasks: SpecTask[]; taskId: string; agent: AgentType; text: string }
  | { kind: 'fail'; tasks: SpecTask[] }
  | { kind: 'none'; tasks: SpecTask[] }
export function deliveryAfterFinish(input: {
  tasks: readonly SpecTask[]
  finishedAgent: AgentType
  finishedTerminalId: string
  eligible: readonly AgentType[]
  runId: string
  boardPath?: string
  journalPath?: string
}): CreditDelivery
```

- [ ] **Step 1: Extend the failing tests**

Add to `src/lib/types.ts` before writing tests that use `queued` (the test file will not typecheck until this lands, so do this edit in the same step as the new assertions):

```ts
export type SpecTaskStatus = 'pending' | 'running' | 'queued' | 'done' | 'failed'
```

On `SpecTask`, after `status`:

```ts
  /** Set when status is `queued`, so the oldest blocked slice is resumed first. */
  queuedAt?: number
```

On `PromptRun`, after `allowedAgents`:

```ts
  /** CLIs that ran out of credit during this run. They are not opened again until the next run. */
  exhaustedAgents?: AgentType[]
```

Append to `creditQueue.test.ts`:

```ts
import type { AgentType, SpecTask } from '../types'
import {
  buildCreditContinuation,
  decideCreditQueue,
  deliveryAfterFinish,
  failQueuedCodingSlices,
  oldestQueuedCodingSlice,
  withExhaustedAgent,
  withQueuedSlice,
} from './creditQueue'

function slice(overrides: Partial<SpecTask> & Pick<SpecTask, 'id'>): SpecTask {
  return {
    title: overrides.id,
    prompt: `do ${overrides.id}`,
    files: [],
    kind: 'implement',
    agent: 'claude',
    dependsOn: [],
    status: 'pending',
    ...overrides,
  }
}

describe('credit queue', () => {
  it('queues the running slice and remembers the exhausted CLI once', () => {
    const tasks = withQueuedSlice(
      [slice({ id: 'a', status: 'running', terminalId: 'term-a' })],
      'term-a',
      50,
    )
    expect(tasks[0]).toMatchObject({ status: 'queued', queuedAt: 50, terminalId: undefined })
    expect(withExhaustedAgent(['codex'], 'claude')).toEqual(['codex', 'claude'])
    expect(withExhaustedAgent(['claude'], 'claude')).toEqual(['claude'])
  })

  it('waits while another coding slice is running', () => {
    const tasks = [
      slice({ id: 'a', status: 'queued', queuedAt: 1 }),
      slice({ id: 'b', status: 'running', agent: 'codex', terminalId: 'term-b' }),
    ]
    expect(decideCreditQueue(tasks, ['codex'])).toBe('wait')
  })

  it('opens when nobody coding is running and a CLI still has credit', () => {
    const tasks = [slice({ id: 'a', status: 'queued', queuedAt: 1, agent: 'claude' })]
    expect(decideCreditQueue(tasks, ['codex'])).toBe('open')
  })

  it('fails every queued coding slice when no CLI has credit and nobody is running', () => {
    const tasks = [
      slice({ id: 'a', status: 'queued', queuedAt: 1 }),
      slice({ id: 'b', status: 'queued', queuedAt: 2, agent: 'codex' }),
    ]
    expect(decideCreditQueue(tasks, [])).toBe('fail')
    expect(failQueuedCodingSlices(tasks).map((item) => item.status)).toEqual(['failed', 'failed'])
  })

  it('picks the oldest queued coding slice', () => {
    const tasks = [
      slice({ id: 'new', status: 'queued', queuedAt: 20 }),
      slice({ id: 'old', status: 'queued', queuedAt: 10, agent: 'codex' }),
      slice({ id: 'shell', status: 'queued', queuedAt: 1, kind: 'shell', agent: 'shell' }),
    ]
    expect(oldestQueuedCodingSlice(tasks)?.id).toBe('old')
  })

  it('builds a slice continuation without the SPEC body', () => {
    const text = buildCreditContinuation({
      runId: 'run_1',
      task: { id: 't2', title: 'Web', prompt: 'Finish the web login form.' },
      boardPath: '.flashwork/runs/run_1/board.md',
      journalPath: '/tmp/journal.md',
      doneIds: ['t1'],
    })
    expect(text).toContain('The previous CLI stopped because credit ran out. Finish only this slice.')
    expect(text).toContain('t2')
    expect(text).toContain('Web')
    expect(text).toContain('Finish the web login form.')
    expect(text).toContain('.flashwork/runs/run_1/board.md')
    expect(text).toContain('/tmp/journal.md')
    expect(text).toContain('t1')
    expect(text).not.toContain('SPEC body')
  })

  it('types the oldest queued slice into the coding pane that just finished', () => {
    const tasks = [
      slice({ id: 'a', status: 'done', agent: 'codex', terminalId: 'term-b' }),
      slice({ id: 'old', status: 'queued', queuedAt: 1, prompt: 'finish old' }),
      slice({ id: 'new', status: 'queued', queuedAt: 2, prompt: 'finish new' }),
    ]
    const delivery = deliveryAfterFinish({
      tasks,
      finishedAgent: 'codex',
      finishedTerminalId: 'term-b',
      eligible: ['claude'],
      runId: 'run_1',
      boardPath: '.flashwork/runs/run_1/board.md',
      journalPath: '/tmp/journal.md',
    })
    expect(delivery.kind).toBe('type')
    if (delivery.kind !== 'type') return
    expect(delivery.terminalId).toBe('term-b')
    expect(delivery.text).toContain('finish old')
    expect(delivery.text).toContain('a')
    expect(delivery.tasks.find((item) => item.id === 'old')).toMatchObject({
      status: 'running',
      agent: 'codex',
      terminalId: 'term-b',
    })
    expect(delivery.tasks.find((item) => item.id === 'new')?.status).toBe('queued')
  })

  it('does not type a coding slice into a shell pane', () => {
    const delivery = deliveryAfterFinish({
      tasks: [
        slice({ id: 'shell', status: 'done', kind: 'shell', agent: 'shell', terminalId: 'sh' }),
        slice({ id: 'old', status: 'queued', queuedAt: 1 }),
      ],
      finishedAgent: 'shell',
      finishedTerminalId: 'sh',
      eligible: ['codex'],
      runId: 'run_1',
    })
    expect(delivery.kind).toBe('open')
    if (delivery.kind !== 'open') return
    expect(delivery.agent).toBe('codex')
    expect(delivery.taskId).toBe('old')
  })

  it('leaves the queue alone when a shell finishes and a coding CLI is still running', () => {
    const delivery = deliveryAfterFinish({
      tasks: [
        slice({ id: 'shell', status: 'done', kind: 'shell', agent: 'shell', terminalId: 'sh' }),
        slice({ id: 'live', status: 'running', agent: 'codex', terminalId: 'cx' }),
        slice({ id: 'old', status: 'queued', queuedAt: 1 }),
      ],
      finishedAgent: 'shell',
      finishedTerminalId: 'sh',
      eligible: ['codex'],
      runId: 'run_1',
    })
    expect(delivery.kind).toBe('none')
  })
})
```

In `specProgress.test.ts`, replace the first expectation with:

```ts
  it('counts only done tasks toward percent and keeps queued work remaining', () => {
    const progress = specProgress(
      [
        { status: 'done', title: 'API' },
        { status: 'running', title: 'Web' },
        { status: 'pending', title: 'Docs' },
        { status: 'failed', title: 'Broken' },
        { status: 'queued', title: 'Queued' },
      ],
      1_000,
      61_000,
    )
    expect(progress).toMatchObject({
      total: 5,
      done: 1,
      remaining: 3,
      percent: 20,
      currentTitle: 'Web',
    })
    expect(progress.etaMs).toBe(180_000)
  })

  it('names a queued slice when nothing is running', () => {
    const progress = specProgress([{ status: 'queued', title: 'Queued' }], 0, 10_000)
    expect(progress.currentTitle).toBe('Queued')
    expect(progress.remaining).toBe(1)
    expect(progress.percent).toBe(0)
    expect(progress.etaMs).toBeNull()
  })
```

Remove the old test titled `counts finished tasks toward 100 percent and names the running task`. Keep the "does not invent an estimate" test and `formatEta`.

In `specPlan.test.ts`, inside `describe('scheduling')`, add:

```ts
  it('does not treat a queued slice as settled or ready to launch', () => {
    const plan = [task({ id: 'a', status: 'queued', queuedAt: 1 }), task({ id: 'b', dependsOn: ['a'] })]
    expect(specRunSettled(plan)).toBe(false)
    expect(readySpecTasks(plan)).toEqual([])
  })
```

`readySpecTasks` and `specRunSettled` need no production change: `queued` is not `pending`, `done`, or `failed`. The test locks that.

- [ ] **Step 2: Run the tests to verify the new queue cases fail**

Run: `pnpm exec vitest run src/lib/promptRun/creditQueue.test.ts src/lib/promptRun/specProgress.test.ts src/lib/promptRun/specPlan.test.ts`

Expected: `creditQueue.test.ts` FAIL on missing exports. `specProgress.test.ts` FAIL because percent still counts `failed` and there is no `queued` handling. `specPlan.test.ts` PASS.

- [ ] **Step 3: Implement the queue**

Append to `src/lib/promptRun/creditQueue.ts`:

```ts
import { HANDOFF_PREF } from './detectHandoffTrigger'
import { isSpecWorkerAgent } from './specPlan'
import type { SpecTask } from '../types'

export function withQueuedSlice(tasks: readonly SpecTask[], terminalId: string, now: number): SpecTask[] {
  return tasks.map((task) =>
    task.terminalId === terminalId && task.status === 'running'
      ? { ...task, status: 'queued' as const, queuedAt: now, terminalId: undefined }
      : task,
  )
}

export function withExhaustedAgent(current: readonly AgentType[] | undefined, agent: AgentType): AgentType[] {
  const list = current ?? []
  if (!isSpecWorkerAgent(agent) || list.includes(agent)) return [...list]
  return [...list, agent]
}

export function oldestQueuedCodingSlice(tasks: readonly SpecTask[]): SpecTask | null {
  const queued = tasks.filter(
    (task) => task.status === 'queued' && task.kind !== 'shell' && isSpecWorkerAgent(task.agent),
  )
  if (queued.length === 0) return null
  return [...queued].sort((left, right) => (left.queuedAt ?? 0) - (right.queuedAt ?? 0))[0] ?? null
}

function codingSliceRunning(tasks: readonly SpecTask[]): boolean {
  return tasks.some((task) => task.status === 'running' && task.kind !== 'shell' && isSpecWorkerAgent(task.agent))
}

export function decideCreditQueue(tasks: readonly SpecTask[], eligible: readonly AgentType[]): 'wait' | 'open' | 'fail' {
  if (codingSliceRunning(tasks)) return 'wait'
  if (eligible.length > 0) return 'open'
  return 'fail'
}

export function failQueuedCodingSlices(tasks: readonly SpecTask[]): SpecTask[] {
  return tasks.map((task) =>
    task.status === 'queued' && task.kind !== 'shell' && isSpecWorkerAgent(task.agent)
      ? { ...task, status: 'failed' as const }
      : task,
  )
}

export function buildCreditContinuation(input: {
  runId: string
  task: Pick<SpecTask, 'id' | 'title' | 'prompt'>
  boardPath?: string
  journalPath?: string
  doneIds: readonly string[]
}): string {
  const lines = [
    'The previous CLI stopped because credit ran out. Finish only this slice.',
    `Slice ${input.task.id} "${input.task.title}" of run ${input.runId}.`,
  ]
  if (input.boardPath) lines.push(`Shared board: ${input.boardPath}`)
  if (input.journalPath) lines.push(`Run journal: ${input.journalPath}`)
  lines.push(`Slices already done: ${input.doneIds.length > 0 ? input.doneIds.join(', ') : 'none'}`)
  lines.push('', input.task.prompt)
  return lines.join('\n')
}

export type CreditDelivery =
  | { kind: 'type'; tasks: SpecTask[]; terminalId: string; text: string }
  | { kind: 'open'; tasks: SpecTask[]; taskId: string; agent: AgentType; text: string }
  | { kind: 'fail'; tasks: SpecTask[] }
  | { kind: 'none'; tasks: SpecTask[] }

export function deliveryAfterFinish(input: {
  tasks: readonly SpecTask[]
  finishedAgent: AgentType
  finishedTerminalId: string
  eligible: readonly AgentType[]
  runId: string
  boardPath?: string
  journalPath?: string
}): CreditDelivery {
  const queued = oldestQueuedCodingSlice(input.tasks)
  if (!queued) return { kind: 'none', tasks: [...input.tasks] }
  const doneIds = input.tasks.filter((task) => task.status === 'done').map((task) => task.id)
  const text = buildCreditContinuation({
    runId: input.runId,
    task: queued,
    boardPath: input.boardPath,
    journalPath: input.journalPath,
    doneIds,
  })
  const finisherCanTakeIt = input.finishedAgent !== 'shell' && isSpecWorkerAgent(input.finishedAgent)
  if (finisherCanTakeIt) {
    return {
      kind: 'type',
      terminalId: input.finishedTerminalId,
      text,
      tasks: input.tasks.map((task) =>
        task.id === queued.id
          ? {
              ...task,
              status: 'running' as const,
              agent: input.finishedAgent,
              terminalId: input.finishedTerminalId,
              queuedAt: undefined,
            }
          : task,
      ),
    }
  }
  if (codingSliceRunning(input.tasks)) return { kind: 'none', tasks: [...input.tasks] }
  const agent = HANDOFF_PREF.find((item) => input.eligible.includes(item)) ?? input.eligible[0]
  if (!agent) return { kind: 'fail', tasks: failQueuedCodingSlices(input.tasks) }
  return { kind: 'open', taskId: queued.id, agent, text, tasks: [...input.tasks] }
}
```

Merge the imports at the top of `creditQueue.ts` into one import block. Do not import `AgentType` twice.

Replace the counting lines in `specProgress`:

```ts
  const done = tasks.filter((task) => task.status === 'done').length
  const current =
    tasks.find((task) => task.status === 'running') ??
    tasks.find((task) => task.status === 'pending') ??
    tasks.find((task) => task.status === 'queued')
  const remaining = tasks.filter(
    (task) => task.status === 'pending' || task.status === 'running' || task.status === 'queued',
  ).length
  const percent = total === 0 ? 0 : Math.round((done / total) * 100)
```

Leave `etaMs` as it is. It already uses `done` and `remaining`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/lib/promptRun/creditQueue.test.ts src/lib/promptRun/specProgress.test.ts src/lib/promptRun/specPlan.test.ts src/lib/promptRun/laneFailure.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

Skip unless the owner asked for commits.

```bash
git add src/lib/types.ts src/lib/promptRun/creditQueue.ts src/lib/promptRun/creditQueue.test.ts src/lib/promptRun/specProgress.ts src/lib/promptRun/specProgress.test.ts src/lib/promptRun/specPlan.test.ts
git commit -m "$(cat <<'EOF'
Queue a SPEC slice when its CLI runs out of credit instead of dropping it.

EOF
)"
```

---

### Task 3: Apply the queue to the board, the pane, and the PTY

**Files:**
- Create: `src/lib/promptRun/specCreditActions.ts`
- Create: `src/lib/promptRun/specCreditActions.test.ts`
- Test: `src/lib/promptRun/specCreditActions.test.ts`

**Interfaces:**
- Consumes: `withQueuedSlice`, `withExhaustedAgent`, `decideCreditQueue`, `failQueuedCodingSlices`, `deliveryAfterFinish`, `oldestQueuedCodingSlice` from `creditQueue.ts`; `specHandoffAgents` and `specRunSettled` from `specPlan.ts`; `PromptRun` and `AgentType` from `types.ts`; `AGENT_TYPE_LABELS` from `types.ts`
- Produces:

```ts
export type SpecCreditPorts = {
  now: () => number
  appendBoard: (cwd: string, runId: string, heading: string, body: string) => Promise<unknown>
  appendJournal: (runId: string, heading: string, body: string) => Promise<unknown>
  deleteTerminal: (projectId: string, terminalId: string) => void
  patchRun: (projectId: string, patch: Partial<PromptRun>) => void
  launchPane: (args: {
    projectId: string
    cwd: string
    runId: string
    agent: AgentType
    name: string
    bootstrap: string
  }) => Promise<{ terminalId: string }>
  writePty: (ptyId: string, data: string) => Promise<void>
  ptyIdFor: (projectId: string, terminalId: string) => string | null
  toast: (toast: { title: string; body: string; agent?: AgentType }) => void
  continueRun: (projectId: string) => Promise<void>
  finishIfSettled: (projectId: string) => Promise<void>
  label: (agent: AgentType) => string
  copy: {
    waitTitle: string
    waitBody: string
    openTitle: string
    failTitle: string
    failBody: string
  }
}

export async function handleSpecCreditExhausted(
  run: PromptRun,
  terminalId: string,
  sourceAgent: AgentType,
  ports: SpecCreditPorts,
): Promise<void>

export async function deliverFinishedSpecSlice(
  run: PromptRun,
  terminalId: string,
  ports: SpecCreditPorts,
): Promise<void>
```

`copy.waitTitle` and `copy.openTitle` already have `{agent}` replaced by the caller. The action functions receive the finished strings.

- [ ] **Step 1: Write the failing test**

Create `src/lib/promptRun/specCreditActions.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PromptRun, SpecTask } from '../types'
import {
  deliverFinishedSpecSlice,
  handleSpecCreditExhausted,
  resetSpecCreditSeen,
  type SpecCreditPorts,
} from './specCreditActions'

function slice(overrides: Partial<SpecTask> & Pick<SpecTask, 'id'>): SpecTask {
  return {
    title: overrides.id,
    prompt: `do ${overrides.id}`,
    files: [],
    kind: 'implement',
    agent: 'claude',
    dependsOn: [],
    status: 'pending',
    ...overrides,
  }
}

function run(tasks: SpecTask[], extra: Partial<PromptRun> = {}): PromptRun {
  return {
    id: 'run_1',
    projectId: 'proj',
    cwd: '/repo',
    prompt: 'SPEC body that must not be resent',
    status: 'running',
    activeAgent: 'claude',
    activeTerminalId: 'term-a',
    unrestricted: true,
    steps: [],
    journalPath: '/tmp/journal.md',
    boardPath: '.flashwork/runs/run_1/board.md',
    specTasks: tasks,
    allowedAgents: ['claude', 'codex'],
    createdAt: 1,
    ...extra,
  }
}

function ports(overrides: Partial<SpecCreditPorts> = {}): SpecCreditPorts {
  return {
    now: () => 50,
    appendBoard: vi.fn(async () => undefined),
    appendJournal: vi.fn(async () => undefined),
    deleteTerminal: vi.fn(),
    patchRun: vi.fn(),
    launchPane: vi.fn(async () => ({ terminalId: 'term-new' })),
    writePty: vi.fn(async () => undefined),
    ptyIdFor: vi.fn(() => 'pty-b'),
    toast: vi.fn(),
    continueRun: vi.fn(async () => undefined),
    finishIfSettled: vi.fn(async () => undefined),
    label: (agent) => (agent === 'claude' ? 'Claude Code' : 'Codex'),
    copy: {
      waitTitle: 'Claude Code stopped because credit ran out',
      waitBody: 'This slice waits for the next CLI to finish.',
      openTitle: 'Continuing on Codex.',
      failTitle: 'No CLI with credit left to continue.',
      failBody: 'This slice failed.',
    },
    ...overrides,
  }
}

beforeEach(() => {
  resetSpecCreditSeen()
})

describe('handleSpecCreditExhausted', () => {
  it('queues the slice, notes the board, closes the pane, and does not open another while a sibling runs', async () => {
    const used = ports()
    await handleSpecCreditExhausted(
      run([
        slice({ id: 'a', status: 'running', terminalId: 'term-a', title: 'API' }),
        slice({ id: 'b', status: 'running', agent: 'codex', terminalId: 'term-b' }),
      ]),
      'term-a',
      'claude',
      used,
    )
    expect(used.appendBoard).toHaveBeenCalledWith(
      '/repo',
      'run_1',
      'a stopped (Claude Code)',
      'Task "API" stopped because credit ran out.',
    )
    expect(used.appendJournal).toHaveBeenCalled()
    const patch = vi.mocked(used.patchRun).mock.calls[0]?.[1]
    expect(patch?.specTasks?.find((task) => task.id === 'a')).toMatchObject({
      status: 'queued',
      queuedAt: 50,
      terminalId: undefined,
    })
    expect(patch?.exhaustedAgents).toEqual(['claude'])
    expect(used.deleteTerminal).toHaveBeenCalledWith('proj', 'term-a')
    expect(used.launchPane).not.toHaveBeenCalled()
    expect(used.toast).toHaveBeenCalledWith({
      title: 'Claude Code stopped because credit ran out',
      body: 'This slice waits for the next CLI to finish.',
      agent: 'claude',
    })
  })

  it('opens the next CLI when nobody else is running', async () => {
    const used = ports()
    await handleSpecCreditExhausted(
      run([slice({ id: 'a', status: 'running', terminalId: 'term-a', title: 'API', prompt: 'finish api' })]),
      'term-a',
      'claude',
      used,
    )
    expect(used.deleteTerminal).toHaveBeenCalledWith('proj', 'term-a')
    expect(used.launchPane).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'codex', projectId: 'proj', cwd: '/repo', runId: 'run_1' }),
    )
    const bootstrap = vi.mocked(used.launchPane).mock.calls[0]?.[0].bootstrap ?? ''
    expect(bootstrap).toContain('finish api')
    expect(bootstrap).not.toContain('SPEC body that must not be resent')
    const runningPatch = vi.mocked(used.patchRun).mock.calls.at(-1)?.[1]
    expect(runningPatch?.specTasks?.find((task) => task.id === 'a')).toMatchObject({
      status: 'running',
      agent: 'codex',
      terminalId: 'term-new',
    })
    expect(used.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Continuing on Codex.', agent: 'codex' }),
    )
  })

  it('fails the queued slice when no CLI has credit left', async () => {
    const used = ports()
    await handleSpecCreditExhausted(
      run(
        [slice({ id: 'a', status: 'running', terminalId: 'term-a' })],
        { allowedAgents: ['claude'], exhaustedAgents: [] },
      ),
      'term-a',
      'claude',
      used,
    )
    expect(used.launchPane).not.toHaveBeenCalled()
    const patch = vi.mocked(used.patchRun).mock.calls.at(-1)?.[1]
    expect(patch?.specTasks?.find((task) => task.id === 'a')?.status).toBe('failed')
    expect(used.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'No CLI with credit left to continue.' }),
    )
    expect(used.finishIfSettled).toHaveBeenCalledWith('proj')
  })

  it('ignores a second credit signal for the same pane', async () => {
    const used = ports()
    const current = run([
      slice({ id: 'a', status: 'running', terminalId: 'term-a' }),
      slice({ id: 'b', status: 'running', agent: 'codex', terminalId: 'term-b' }),
    ])
    await handleSpecCreditExhausted(current, 'term-a', 'claude', used)
    await handleSpecCreditExhausted(current, 'term-a', 'claude', used)
    expect(used.deleteTerminal).toHaveBeenCalledTimes(1)
  })
})

describe('deliverFinishedSpecSlice', () => {
  it('types the oldest queued slice into the pane that just finished', async () => {
    const used = ports()
    await deliverFinishedSpecSlice(
      run([
        slice({ id: 'a', status: 'done', agent: 'codex', terminalId: 'term-b' }),
        slice({ id: 'old', status: 'queued', queuedAt: 1, prompt: 'finish old', title: 'Old' }),
      ]),
      'term-b',
      used,
    )
    expect(used.writePty).toHaveBeenCalledWith('pty-b', expect.stringContaining('finish old\r'))
    expect(used.launchPane).not.toHaveBeenCalled()
    expect(used.continueRun).toHaveBeenCalledWith('proj')
  })

  it('opens a pane when the finisher is a shell and nobody coding is running', async () => {
    const used = ports()
    await deliverFinishedSpecSlice(
      run([
        slice({ id: 'sh', status: 'done', kind: 'shell', agent: 'shell', terminalId: 'sh' }),
        slice({ id: 'old', status: 'queued', queuedAt: 1, prompt: 'finish old' }),
      ]),
      'sh',
      used,
    )
    expect(used.writePty).not.toHaveBeenCalled()
    expect(used.launchPane).toHaveBeenCalledWith(expect.objectContaining({ agent: 'codex' }))
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/lib/promptRun/specCreditActions.test.ts`

Expected: FAIL, cannot find `./specCreditActions`.

- [ ] **Step 3: Implement the actions**

Create `src/lib/promptRun/specCreditActions.ts`:

```ts
import { AGENT_TYPE_LABELS, type AgentType, type PromptRun, type PromptRunStep } from '../types'
import {
  decideCreditQueue,
  deliveryAfterFinish,
  failQueuedCodingSlices,
  withExhaustedAgent,
  withQueuedSlice,
} from './creditQueue'
import { specHandoffAgents } from './specPlan'

const seenCredit = new Set<string>()

export type SpecCreditPorts = {
  now: () => number
  appendBoard: (cwd: string, runId: string, heading: string, body: string) => Promise<unknown>
  appendJournal: (runId: string, heading: string, body: string) => Promise<unknown>
  deleteTerminal: (projectId: string, terminalId: string) => void
  patchRun: (projectId: string, patch: Partial<PromptRun>) => void
  launchPane: (args: {
    projectId: string
    cwd: string
    runId: string
    agent: AgentType
    name: string
    bootstrap: string
  }) => Promise<{ terminalId: string }>
  writePty: (ptyId: string, data: string) => Promise<void>
  ptyIdFor: (projectId: string, terminalId: string) => string | null
  toast: (toast: { title: string; body: string; agent?: AgentType }) => void
  continueRun: (projectId: string) => Promise<void>
  finishIfSettled: (projectId: string) => Promise<void>
  label: (agent: AgentType) => string
  copy: {
    waitTitle: string
    waitBody: string
    openTitle: string
    failTitle: string
    failBody: string
  }
}

function eligibleAgents(run: PromptRun): AgentType[] {
  const pool = specHandoffAgents(run) ?? []
  const blocked = new Set(run.exhaustedAgents ?? [])
  return pool.filter((agent) => !blocked.has(agent))
}

async function noteStop(run: PromptRun, task: { id: string; title: string; agent: AgentType }, ports: SpecCreditPorts) {
  const heading = `${task.id} stopped (${AGENT_TYPE_LABELS[task.agent]})`
  const body = `Task "${task.title}" stopped because credit ran out.`
  await ports.appendBoard(run.cwd, run.id, heading, body).catch(() => undefined)
  await ports.appendJournal(run.id, heading, body).catch(() => undefined)
}

async function openOldest(
  run: PromptRun,
  tasks: PromptRun['specTasks'],
  agent: AgentType,
  taskId: string,
  bootstrap: string,
  ports: SpecCreditPorts,
): Promise<void> {
  const created = await ports.launchPane({
    projectId: run.projectId,
    cwd: run.cwd,
    runId: run.id,
    agent,
    name: `${taskId} · ${AGENT_TYPE_LABELS[agent]}`,
    bootstrap,
  })
  const now = ports.now()
  const step: PromptRunStep = { agent, reason: 'quota', startedAt: now, terminalId: created.terminalId }
  ports.patchRun(run.projectId, {
    specTasks: (tasks ?? []).map((task) =>
      task.id === taskId
        ? { ...task, status: 'running' as const, agent, terminalId: created.terminalId, queuedAt: undefined }
        : task,
    ),
    steps: [...run.steps, step],
    activeAgent: agent,
    activeTerminalId: created.terminalId,
  })
  const opened = (tasks ?? []).find((item) => item.id === taskId)
  const agentLabel = AGENT_TYPE_LABELS[agent]
  ports.toast({
    title: ports.copy.openTitle.replaceAll('{agent}', agentLabel),
    body: opened?.title ?? agentLabel,
    agent,
  })
}

export async function handleSpecCreditExhausted(
  run: PromptRun,
  terminalId: string,
  sourceAgent: AgentType,
  ports: SpecCreditPorts,
): Promise<void> {
  if (!run.specTasks) return
  const key = `${run.id}:${terminalId}`
  if (seenCredit.has(key)) return
  const task = run.specTasks.find((item) => item.terminalId === terminalId && item.status === 'running')
  if (!task) return
  seenCredit.add(key)
  await noteStop(run, task, ports)
  const exhaustedAgents = withExhaustedAgent(run.exhaustedAgents, sourceAgent)
  const queued = withQueuedSlice(run.specTasks, terminalId, ports.now())
  const eligible = eligibleAgents({ ...run, exhaustedAgents })
  const action = decideCreditQueue(queued, eligible)
  ports.patchRun(run.projectId, { specTasks: queued, exhaustedAgents })
  try {
    ports.deleteTerminal(run.projectId, terminalId)
  } catch (cause) {
    console.warn('[run-spec] credit pane close failed:', cause)
  }
  if (action === 'wait') {
    ports.toast({ title: ports.copy.waitTitle, body: ports.copy.waitBody, agent: sourceAgent })
    return
  }
  const oldest = queued.find((item) => item.status === 'queued')
  if (action === 'fail' || !oldest) {
    ports.patchRun(run.projectId, { specTasks: failQueuedCodingSlices(queued), exhaustedAgents })
    ports.toast({ title: ports.copy.failTitle, body: ports.copy.failBody, agent: sourceAgent })
    await ports.finishIfSettled(run.projectId)
    return
  }
  const delivery = deliveryAfterFinish({
    tasks: queued,
    finishedAgent: 'shell',
    finishedTerminalId: '',
    eligible,
    runId: run.id,
    boardPath: run.boardPath,
    journalPath: run.journalPath,
  })
  if (delivery.kind !== 'open') {
    ports.patchRun(run.projectId, { specTasks: failQueuedCodingSlices(queued), exhaustedAgents })
    ports.toast({ title: ports.copy.failTitle, body: ports.copy.failBody, agent: sourceAgent })
    await ports.finishIfSettled(run.projectId)
    return
  }
  await openOldest(run, queued, delivery.agent, delivery.taskId, delivery.text, ports)
}

export async function deliverFinishedSpecSlice(
  run: PromptRun,
  terminalId: string,
  ports: SpecCreditPorts,
): Promise<void> {
  if (!run.specTasks) return
  const finished = run.specTasks.find((task) => task.terminalId === terminalId)
  const delivery = deliveryAfterFinish({
    tasks: run.specTasks,
    finishedAgent: finished?.agent ?? 'shell',
    finishedTerminalId: terminalId,
    eligible: eligibleAgents(run),
    runId: run.id,
    boardPath: run.boardPath,
    journalPath: run.journalPath,
  })
  if (delivery.kind === 'none') {
    await ports.continueRun(run.projectId)
    await ports.finishIfSettled(run.projectId)
    return
  }
  if (delivery.kind === 'type') {
    ports.patchRun(run.projectId, { specTasks: delivery.tasks })
    const ptyId = ports.ptyIdFor(run.projectId, delivery.terminalId)
    if (ptyId) await ports.writePty(ptyId, `${delivery.text}\r`)
    await ports.continueRun(run.projectId)
    return
  }
  if (delivery.kind === 'fail') {
    ports.patchRun(run.projectId, { specTasks: delivery.tasks })
    ports.toast({ title: ports.copy.failTitle, body: ports.copy.failBody })
    await ports.finishIfSettled(run.projectId)
    return
  }
  await openOldest({ ...run, specTasks: delivery.tasks }, delivery.tasks, delivery.agent, delivery.taskId, delivery.text, ports)
  await ports.continueRun(run.projectId)
}

export function resetSpecCreditSeen(): void {
  seenCredit.clear()
}
```

`handleSpecCreditExhausted` passes the queued tasks into `deliveryAfterFinish` with `finishedAgent: 'shell'` so the open branch runs when no coding slice is still `running`. The slice stays `queued` until `openOldest` marks it `running`.

The fail test's `allowedAgents` is only `claude`. After `withExhaustedAgent`, claude is exhausted, eligible becomes `[]`, and the last `patchRun` stores `failed`.

`openOldest` appends one step onto `run.steps` from the object passed in. That array is still `[]` after the first patch.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run src/lib/promptRun/specCreditActions.test.ts src/lib/promptRun/creditQueue.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

Skip unless the owner asked for commits.

```bash
git add src/lib/promptRun/specCreditActions.ts src/lib/promptRun/specCreditActions.test.ts
git commit -m "$(cat <<'EOF'
Close an exhausted SPEC pane and resume its slice on a CLI that still has credit.

EOF
)"
```

---

### Task 4: Wire the watcher, slice completion, copy, and changelog

**Files:**
- Modify: `src/hooks/usePromptRunWatcher.ts` (the usage poll and the start of `considerTrigger`)
- Modify: `src/lib/promptRun/runSpec.ts` (`noteSpecTerminalComplete`)
- Modify: `src/lib/i18n/messages/en.ts` (next to `runSpec.progressEtaPending`)
- Modify: `src/lib/i18n/messages/pt-BR.ts` (same keys)
- Modify: `docs/CHANGELOG.md` under `## [Unreleased]` → `### Added`
- Test: `src/lib/promptRun/specCreditActions.test.ts` plus `pnpm exec tsc --noEmit`

**Interfaces:**
- Consumes: `handleSpecCreditExhausted`, `deliverFinishedSpecSlice`, `SpecCreditPorts` from `specCreditActions.ts`; `isCreditExhausted` from `creditQueue.ts`; `appendProjectRunBoard`, `appendPromptRunJournal` from `src/lib/tauri`; `writePty` from `src/lib/tauri/pty`; `launchPromptRunLanes` from `startPromptRun.ts`; `deleteTerminal` and `createAgentTerminal` on `useProjectsStore`; `PtyStatus` via `useTerminalsStore`
- Produces: no new exported function. SPEC credit no longer falls through to `decideLaneFailure`.

- [ ] **Step 1: Add the copy**

In `src/lib/i18n/messages/en.ts`, after `runSpec.progressEtaPending`:

```ts
  'runSpec.creditWaitTitle': '{agent} stopped because credit ran out',
  'runSpec.creditWaitBody': 'This slice waits for the next CLI to finish.',
  'runSpec.creditOpenTitle': 'Continuing on {agent}.',
  'runSpec.creditFailTitle': 'No CLI with credit left to continue.',
  'runSpec.creditFailBody': 'This slice failed.',
```

In `src/lib/i18n/messages/pt-BR.ts`, after the same key:

```ts
  'runSpec.creditWaitTitle': '{agent} parou por crédito',
  'runSpec.creditWaitBody': 'A fatia espera o próximo CLI terminar.',
  'runSpec.creditOpenTitle': 'Continuando no {agent}.',
  'runSpec.creditFailTitle': 'Nenhum CLI com crédito para continuar.',
  'runSpec.creditFailBody': 'A fatia falhou.',
```

In `docs/CHANGELOG.md`, under `### Added` inside `## [Unreleased]`, add:

```md
- Run SPEC keeps a slice going when a CLI runs out of credit. The pane closes. If another CLI is
  still working, the slice waits and is typed into that CLI when its current slice finishes. If
  nobody is working, the next CLI that still has credit opens immediately. A CLI that ran out of
  credit is not opened again in that run.
```

- [ ] **Step 2: Add a real ports builder and call it**

Add `src/lib/promptRun/specCreditPorts.ts`:

```ts
import { AGENT_TYPE_LABELS, type AgentType } from '../types'
import { translate, getLocale } from '../i18n'
import { appendProjectRunBoard, appendPromptRunJournal } from '../tauri'
import { writePty } from '../tauri/pty'
import { useProjectsStore } from '../../stores/projectsStore'
import { usePromptRunStore } from '../../stores/promptRunStore'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { useUiStore } from '../../stores/uiStore'
import { launchPromptRunLanes } from './startPromptRun'
import { continueSpecRun, finishSpecRunIfSettled } from './runSpec'
import type { SpecCreditPorts } from './specCreditActions'

export function lanePtyStatus(projectId: string, terminalId: string): 'working' | 'waiting' | 'stopped' | 'disabled' | 'offline' | 'unknown' {
  const project = useProjectsStore.getState().projects.find((item) => item.id === projectId)
  const terminal = project?.terminals.find((item) => item.id === terminalId)
  const tab = terminal?.tabs.find((item) => item.id === terminal.activeTabId) ?? terminal?.tabs[0]
  if (!tab?.ptyId) return 'unknown'
  return useTerminalsStore.getState().byPtyId[tab.ptyId]?.status ?? 'unknown'
}

export function ptyIdForTerminal(projectId: string, terminalId: string): string | null {
  const project = useProjectsStore.getState().projects.find((item) => item.id === projectId)
  const terminal = project?.terminals.find((item) => item.id === terminalId)
  const tab = terminal?.tabs.find((item) => item.id === terminal.activeTabId) ?? terminal?.tabs[0]
  return tab?.ptyId ?? null
}

export function liveSpecCreditPorts(sourceAgent: AgentType): SpecCreditPorts {
  const locale = getLocale()
  const label = AGENT_TYPE_LABELS[sourceAgent]
  return {
    now: () => Date.now(),
    appendBoard: appendProjectRunBoard,
    appendJournal: appendPromptRunJournal,
    deleteTerminal: (projectId, terminalId) => useProjectsStore.getState().deleteTerminal(projectId, terminalId),
    patchRun: (projectId, patch) => usePromptRunStore.getState().patchRun(projectId, patch),
    launchPane: async (args) => {
      const steps = await launchPromptRunLanes({
        projectId: args.projectId,
        cwd: args.cwd,
        runId: args.runId,
        unrestricted: true,
        lanes: [
          {
            agent: args.agent,
            role: 'worker',
            taskKind: 'implement',
            reason: 'quota',
            skillNames: [],
            slicePrompt: args.bootstrap,
            paneName: args.name,
            independentSession: true,
            bootstrap: args.bootstrap,
          },
        ],
        createAgentTerminal: (projectId, launch) => useProjectsStore.getState().createAgentTerminal(projectId, launch),
      })
      const terminalId = steps[0]?.terminalId
      if (!terminalId) throw new Error('credit pane did not open')
      return { terminalId }
    },
    writePty,
    ptyIdFor: ptyIdForTerminal,
    toast: (toast) => useUiStore.getState().pushToast(toast),
    continueRun: continueSpecRun,
    finishIfSettled: finishSpecRunIfSettled,
    label: (agent) => AGENT_TYPE_LABELS[agent],
    copy: {
      waitTitle: translate(locale, 'runSpec.creditWaitTitle', { agent: label }),
      waitBody: translate(locale, 'runSpec.creditWaitBody'),
      openTitle: translate(locale, 'runSpec.creditOpenTitle', { agent: '{agent}' }),
      failTitle: translate(locale, 'runSpec.creditFailTitle'),
      failBody: translate(locale, 'runSpec.creditFailBody'),
    },
  }
}
```

`translate` substitutes `{agent}`. Passing `agent: '{agent}'` leaves the token in place, and `openOldest` replaces it with the CLI that actually opens. `waitTitle` keeps the source agent label from `label`.

Export `finishSpecRunIfSettled` from `runSpec.ts` as a wrapper that calls the existing private `finishSpecRun`. Add:

```ts
export async function finishSpecRunIfSettled(projectId: string): Promise<void> {
  const run = usePromptRunStore.getState().byProjectId[projectId]
  if (run?.specTasks && specRunSettled(run.specTasks)) await finishSpecRun(projectId)
}
```

`finishSpecRun` is private in the same file, so this wrapper can call it. `specRunSettled` is already imported from `./specPlan` in `runSpec.ts`. Do not add a second import.

In `noteSpecTerminalComplete`, after the existing board/journal append and before `readySpecTasks`:

```ts
  const latest = usePromptRunStore.getState().byProjectId[run.projectId]
  if (latest) {
    await deliverFinishedSpecSlice(latest, terminalId, liveSpecCreditPorts(task.agent))
    return
  }
```

Remove the old `continueSpecRun` / `finishSpecRun` tail from `noteSpecTerminalComplete`. `deliverFinishedSpecSlice` calls `continueRun`, which is `continueSpecRun`. `continueSpecRun` already calls `finishSpecRun` when the run is settled. Returning after `deliverFinishedSpecSlice` avoids launching the queued slice twice.

The `none` branch in Task 3 already calls `continueRun` and then `finishIfSettled`. `continueSpecRun` returns immediately when nothing is ready, so the settled call is what ends a run whose last slice just finished. Add this test to `specCreditActions.test.ts`:

```ts
  it('finishes a settled run when the queue is empty', async () => {
    const used = ports()
    await deliverFinishedSpecSlice(
      run([slice({ id: 'a', status: 'done', terminalId: 'term-b' })]),
      'term-b',
      used,
    )
    expect(used.continueRun).toHaveBeenCalledWith('proj')
    expect(used.finishIfSettled).toHaveBeenCalledWith('proj')
    expect(used.writePty).not.toHaveBeenCalled()
  })
```

Run that test after the branch change. Expected: PASS.

In `usePromptRunWatcher.ts`, import `isCreditExhausted` from `../lib/promptRun/creditQueue`, `handleSpecCreditExhausted` from `../lib/promptRun/specCreditActions`, and `lanePtyStatus`, `liveSpecCreditPorts` from `../lib/promptRun/specCreditPorts`.

At the start of `considerTrigger`, after the API-agent return:

```ts
    if (run.specTasks && !isApiAgentId(sourceAgent)) {
      const blocked = isCreditExhausted({
        agent: sourceAgent,
        claudeFiveHourUtilization: usageRef.current.claudeFiveHourUtilization,
        codexRateLimited: usageRef.current.codexRateLimited,
        ptyChunk,
        laneStatus: lanePtyStatus(run.projectId, sourceTerminalId),
      })
      if (blocked) {
        void handleSpecCreditExhausted(
          run,
          sourceTerminalId,
          sourceAgent,
          liveSpecCreditPorts(sourceAgent),
        ).catch((cause) => console.warn('[prompt-run] spec credit queue failed:', cause))
        return
      }
    }
```

Replace the usage-poll loop body:

```ts
      for (const run of runningRuns()) {
        if (run.specTasks) {
          for (const step of runStepTerminals(run)) {
            if (isApiAgentId(step.agent)) continue
            const blocked = isCreditExhausted({
              agent: step.agent,
              claudeFiveHourUtilization: usageRef.current.claudeFiveHourUtilization,
              codexRateLimited: usageRef.current.codexRateLimited,
              ptyChunk: '',
              laneStatus: lanePtyStatus(run.projectId, step.terminalId),
            })
            if (!blocked) continue
            void handleSpecCreditExhausted(
              run,
              step.terminalId,
              step.agent,
              liveSpecCreditPorts(step.agent),
            ).catch((cause) => console.warn('[prompt-run] spec credit queue failed:', cause))
          }
          continue
        }
        considerTrigger(run, '')
      }
```

`runStepTerminals` and `isApiAgentId` are already in the watcher file. `step.agent` is `RoutedAgent`. `isCreditExhausted` and `handleSpecCreditExhausted` take `AgentType`. Call them only when `!isApiAgentId(step.agent)`, then the agent is an `AgentType`. Narrow with:

```ts
            if (isApiAgentId(step.agent)) continue
            const agent = step.agent
```

`isApiAgentId` is a type predicate that excludes API agents, so `agent` is `AgentType` after the continue. Use `agent` in the calls.

`liveSpecCreditPorts(sourceAgent)` for the wait title uses the exhausted agent. For the open title, Task 4's `replaceAll` uses the target. Build wait copy with the source label and open copy with the `{agent}` placeholder as specified above.

- [ ] **Step 3: Run the tests and the typecheck**

Run: `pnpm exec vitest run src/lib/promptRun/specCreditActions.test.ts src/lib/promptRun/creditQueue.test.ts src/lib/promptRun/specProgress.test.ts src/lib/promptRun/specPlan.test.ts src/lib/promptRun/detectHandoffTrigger.test.ts src/lib/promptRun/laneFailure.test.ts`

Expected: PASS

Run: `pnpm exec tsc --noEmit`

Expected: exit 0. `pt-BR.ts` fails if a new `en.ts` key is missing.

- [ ] **Step 4: Commit**

Skip unless the owner asked for commits.

```bash
git add src/hooks/usePromptRunWatcher.ts src/lib/promptRun/runSpec.ts src/lib/promptRun/specCreditActions.ts src/lib/promptRun/specCreditActions.test.ts src/lib/promptRun/specCreditPorts.ts src/lib/i18n/messages/en.ts src/lib/i18n/messages/pt-BR.ts docs/CHANGELOG.md
git commit -m "$(cat <<'EOF'
Resume a SPEC slice on the next CLI with credit when one runs out.

EOF
)"
```
