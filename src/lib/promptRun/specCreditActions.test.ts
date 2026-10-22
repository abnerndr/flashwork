import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PromptRun, SpecTask } from '../types'
import {
  deliverFinishedSpecSlice,
  handleSpecCreditExhausted,
  openQueuedCodingSliceIfIdle,
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
    getRun: vi.fn(() => undefined),
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

  it('appends the new step to the latest run steps, not the stale snapshot', async () => {
    const original = run([
      slice({ id: 'a', status: 'running', terminalId: 'term-a', title: 'API', prompt: 'finish api' }),
    ])
    const concurrent = { ...original, steps: [{ agent: 'claude' as const, reason: 'user' as const, startedAt: 7, terminalId: 'x' }] }
    const used = ports({ getRun: vi.fn(() => concurrent) })
    await handleSpecCreditExhausted(original, 'term-a', 'claude', used)
    const patch = vi.mocked(used.patchRun).mock.calls.at(-1)?.[1]
    expect(patch?.steps).toHaveLength(2)
    expect(patch?.steps?.[0]).toMatchObject({ terminalId: 'x' })
    expect(patch?.steps?.[1]).toMatchObject({ agent: 'codex', terminalId: 'term-new' })
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

/** In-memory run store: patchRun merges, getRun reads the latest state. */
function sharedStore(initial: PromptRun) {
  let current = initial
  return {
    get: () => current,
    patchRun: vi.fn((_projectId: string, patch: Partial<PromptRun>) => {
      current = { ...current, ...patch }
    }),
    getRun: vi.fn(() => current),
  }
}

function gate() {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

describe('handleSpecCreditExhausted with concurrent lanes', () => {
  it('does not let overlapping credit patches resurrect each other', async () => {
    const store = sharedStore(
      run(
        [
          slice({ id: 'a', status: 'running', terminalId: 'term-a' }),
          slice({ id: 'b', status: 'running', agent: 'codex', terminalId: 'term-b' }),
        ],
        { allowedAgents: ['claude', 'codex', 'opencode'] },
      ),
    )
    const gateA = gate()
    const gateB = gate()
    const gates = [gateA, gateB]
    let call = 0
    const used = ports({
      patchRun: store.patchRun,
      getRun: store.getRun,
      appendBoard: vi.fn(() => gates[call++ % 2].promise),
      launchPane: vi.fn(async () => ({ terminalId: 'term-new' })),
    })
    const snapshot = store.get()
    const first = handleSpecCreditExhausted(snapshot, 'term-a', 'claude', used)
    const second = handleSpecCreditExhausted(snapshot, 'term-b', 'codex', used)
    gateA.open()
    gateB.open()
    await Promise.all([first, second])
    const final = store.get()
    expect(final.exhaustedAgents).toEqual(['claude', 'codex'])
    expect(used.deleteTerminal).toHaveBeenCalledWith('proj', 'term-a')
    expect(used.deleteTerminal).toHaveBeenCalledWith('proj', 'term-b')
    const tasks = final.specTasks ?? []
    expect(tasks.every((task) => task.terminalId !== 'term-a' && task.terminalId !== 'term-b')).toBe(true)
    expect(tasks.filter((task) => task.status === 'running')).toHaveLength(1)
    expect(tasks.filter((task) => task.status === 'queued')).toHaveLength(1)
    expect(used.launchPane).toHaveBeenCalledTimes(1)
    expect(used.launchPane).toHaveBeenCalledWith(expect.objectContaining({ agent: 'opencode' }))
  })

  it('does not revert a slice that finished while the stop note was written', async () => {
    const store = sharedStore(
      run([
        slice({ id: 'a', status: 'running', terminalId: 'term-a' }),
        slice({ id: 'b', status: 'running', agent: 'codex', terminalId: 'term-b' }),
      ]),
    )
    const noteGate = gate()
    const used = ports({
      patchRun: store.patchRun,
      getRun: store.getRun,
      appendBoard: vi.fn(() => noteGate.promise),
    })
    const pending = handleSpecCreditExhausted(store.get(), 'term-a', 'claude', used)
    // Slice a finishes while the note is still being written; b keeps running.
    store.patchRun('proj', {
      specTasks: (store.get().specTasks ?? []).map((task) =>
        task.id === 'a' ? { ...task, status: 'done' as const } : task,
      ),
    })
    store.patchRun.mockClear()
    noteGate.open()
    await pending
    expect(store.patchRun).not.toHaveBeenCalled()
    expect(used.deleteTerminal).not.toHaveBeenCalled()
    expect(store.get().specTasks?.map((task) => task.status)).toEqual(['done', 'running'])
  })

  it('keeps a sibling that finished during the note as done when it queues the other slice', async () => {
    const store = sharedStore(
      run(
        [
          slice({ id: 'a', status: 'running', terminalId: 'term-a' }),
          slice({ id: 'b', status: 'running', agent: 'codex', terminalId: 'term-b' }),
        ],
        { allowedAgents: ['claude', 'codex'] },
      ),
    )
    const noteGate = gate()
    const used = ports({ patchRun: store.patchRun, getRun: store.getRun, appendBoard: vi.fn(() => noteGate.promise) })
    const pending = handleSpecCreditExhausted(store.get(), 'term-a', 'claude', used)
    store.patchRun('proj', {
      specTasks: (store.get().specTasks ?? []).map((task) =>
        task.id === 'b' ? { ...task, status: 'done' as const, terminalId: 'term-b' } : task,
      ),
    })
    noteGate.open()
    await pending
    const tasks = store.get().specTasks ?? []
    expect(tasks.find((task) => task.id === 'b')?.status).toBe('done')
    expect(tasks.find((task) => task.id === 'a')).toMatchObject({ status: 'running', agent: 'codex', terminalId: 'term-new' })
  })
})

describe('launch failure after the exhausted pane closed', () => {
  it('fails the queued slice and settles the run when nobody else is running', async () => {
    const store = sharedStore(run([slice({ id: 'a', status: 'running', terminalId: 'term-a' })]))
    const used = ports({
      patchRun: store.patchRun,
      getRun: store.getRun,
      launchPane: vi.fn(async () => {
        throw new Error('spawn failed')
      }),
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await handleSpecCreditExhausted(store.get(), 'term-a', 'claude', used)
    warn.mockRestore()
    expect(store.get().specTasks?.find((task) => task.id === 'a')?.status).toBe('failed')
    expect(used.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'No CLI with credit left to continue.' }),
    )
    expect(used.finishIfSettled).toHaveBeenCalledWith('proj')
  })

  it('leaves the slice queued when another coding slice started running meanwhile', async () => {
    const store = sharedStore(run([slice({ id: 'a', status: 'running', terminalId: 'term-a' })]))
    const used = ports({
      patchRun: store.patchRun,
      getRun: store.getRun,
      launchPane: vi.fn(async () => {
        // A sibling pane comes up while this launch is in flight, then the launch fails.
        store.patchRun('proj', {
          specTasks: [
            ...(store.get().specTasks ?? []),
            slice({ id: 'c', status: 'running', agent: 'codex', terminalId: 'term-c' }),
          ],
        })
        throw new Error('spawn failed')
      }),
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await handleSpecCreditExhausted(store.get(), 'term-a', 'claude', used)
    warn.mockRestore()
    expect(store.get().specTasks?.find((task) => task.id === 'a')?.status).toBe('queued')
    expect(used.finishIfSettled).not.toHaveBeenCalled()
    expect(used.toast).toHaveBeenCalledWith(expect.objectContaining({ body: 'This slice waits for the next CLI to finish.' }))
  })
})

describe('openQueuedCodingSliceIfIdle', () => {
  it('opens the next eligible CLI, never the exhausted one', async () => {
    const store = sharedStore(
      run(
        [slice({ id: 'late', status: 'queued', queuedAt: 5, agent: 'claude', prompt: 'finish late' })],
        { exhaustedAgents: ['claude'], allowedAgents: ['claude', 'codex'] },
      ),
    )
    const used = ports({ patchRun: store.patchRun, getRun: store.getRun })
    await openQueuedCodingSliceIfIdle('proj', used)
    expect(used.launchPane).toHaveBeenCalledWith(expect.objectContaining({ agent: 'codex' }))
    expect(store.get().specTasks?.[0]).toMatchObject({ status: 'running', agent: 'codex', terminalId: 'term-new' })
  })

  it('leaves the slice queued while a coding slice is running', async () => {
    const store = sharedStore(
      run(
        [
          slice({ id: 'late', status: 'queued', queuedAt: 5 }),
          slice({ id: 'live', status: 'running', agent: 'codex', terminalId: 'term-b' }),
        ],
        { exhaustedAgents: ['claude'] },
      ),
    )
    const used = ports({ patchRun: store.patchRun, getRun: store.getRun })
    await openQueuedCodingSliceIfIdle('proj', used)
    expect(used.launchPane).not.toHaveBeenCalled()
    expect(store.get().specTasks?.[0]?.status).toBe('queued')
  })

  it('fails the queued slice when every allowed CLI is exhausted', async () => {
    const store = sharedStore(
      run([slice({ id: 'late', status: 'queued', queuedAt: 5 })], {
        exhaustedAgents: ['claude', 'codex'],
        allowedAgents: ['claude', 'codex'],
      }),
    )
    const used = ports({ patchRun: store.patchRun, getRun: store.getRun })
    await openQueuedCodingSliceIfIdle('proj', used)
    expect(used.launchPane).not.toHaveBeenCalled()
    expect(store.get().specTasks?.[0]?.status).toBe('failed')
    expect(used.finishIfSettled).toHaveBeenCalledWith('proj')
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
      run(
        [
          slice({ id: 'sh', status: 'done', kind: 'shell', agent: 'shell', terminalId: 'sh' }),
          slice({ id: 'old', status: 'queued', queuedAt: 1, prompt: 'finish old' }),
        ],
        { allowedAgents: ['codex'] },
      ),
      'sh',
      used,
    )
    expect(used.writePty).not.toHaveBeenCalled()
    expect(used.launchPane).toHaveBeenCalledWith(expect.objectContaining({ agent: 'codex' }))
  })

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
})
