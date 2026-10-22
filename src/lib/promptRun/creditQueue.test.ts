import { describe, expect, it } from 'vitest'

import type { AgentType, SpecTask } from '../types'
import {
  buildCreditContinuation,
  decideCreditQueue,
  deliveryAfterFinish,
  failQueuedCodingSlices,
  isCreditExhausted,
  oldestQueuedCodingSlice,
  pickTaskForTerminal,
  readyTaskMustQueue,
  specLaneSkipsLegacyHandoff,
  withExhaustedAgent,
  withQueuedSlice,
} from './creditQueue'

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

  it('keeps invalid-API-key text with a 429 on the legacy failure path', () => {
    expect(isCreditExhausted({ ...base, agent: 'gemini', ptyChunk: 'invalid api key, error 429' })).toBe(false)
  })

  it('keeps a login prompt that also contains a 429 out of the credit queue', () => {
    expect(isCreditExhausted({ ...base, agent: 'claude', ptyChunk: 'Please enter an API key (last error 429)' })).toBe(
      false,
    )
  })

  it('still treats a plain 429 rate limit as credit exhaustion', () => {
    expect(isCreditExhausted({ ...base, agent: 'opencode', ptyChunk: '429 rate limit exceeded' })).toBe(true)
  })
})

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
    expect(delivery.tasks.find((item) => item.id === 'a')?.terminalId).toBeUndefined()
    expect(delivery.tasks.filter((item) => item.terminalId === 'term-b')).toHaveLength(1)
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

describe('pickTaskForTerminal', () => {
  it('prefers the running slice when an earlier done slice shares the terminal id', () => {
    const tasks = [
      slice({ id: 'first', status: 'done', agent: 'codex', terminalId: 'term-b' }),
      slice({ id: 'second', status: 'running', agent: 'codex', terminalId: 'term-b' }),
    ]
    expect(pickTaskForTerminal(tasks, 'term-b')?.id).toBe('second')
  })

  it('falls back to the first match and returns undefined when none match', () => {
    const tasks = [slice({ id: 'only', status: 'done', terminalId: 'term-b' })]
    expect(pickTaskForTerminal(tasks, 'term-b')?.id).toBe('only')
    expect(pickTaskForTerminal(tasks, 'nope')).toBeUndefined()
    expect(pickTaskForTerminal(undefined, 'term-b')).toBeUndefined()
  })
})

describe('specLaneSkipsLegacyHandoff', () => {
  const lane = { ...base, isSpecLane: true }

  it('skips the legacy handoff for credit signals on a SPEC lane', () => {
    expect(specLaneSkipsLegacyHandoff({ ...lane, agent: 'claude', claudeFiveHourUtilization: 85 })).toBe(true)
    expect(specLaneSkipsLegacyHandoff({ ...lane, agent: 'claude', claudeFiveHourUtilization: 99 })).toBe(true)
    expect(specLaneSkipsLegacyHandoff({ ...lane, agent: 'codex', codexRateLimited: true })).toBe(true)
    expect(specLaneSkipsLegacyHandoff({ ...lane, agent: 'opencode', ptyChunk: 'HTTP 429' })).toBe(true)
  })

  it('does not skip below the utilization threshold or without a credit signal', () => {
    expect(specLaneSkipsLegacyHandoff({ ...lane, agent: 'claude', claudeFiveHourUtilization: 79 })).toBe(false)
    expect(specLaneSkipsLegacyHandoff({ ...lane, agent: 'codex', claudeFiveHourUtilization: 95 })).toBe(false)
    expect(specLaneSkipsLegacyHandoff({ ...lane, agent: 'claude', ptyChunk: 'overloaded' })).toBe(false)
  })

  it('keeps login blocks and auth errors on the legacy path', () => {
    expect(
      specLaneSkipsLegacyHandoff({ ...lane, agent: 'claude', claudeFiveHourUtilization: 90, ptyChunk: 'Please enter an API key' }),
    ).toBe(false)
    expect(
      specLaneSkipsLegacyHandoff({ ...lane, agent: 'gemini', ptyChunk: 'invalid api key, error 429' }),
    ).toBe(false)
  })

  it('never skips outside a SPEC lane or for a shell', () => {
    expect(specLaneSkipsLegacyHandoff({ ...lane, isSpecLane: false, agent: 'claude', ptyChunk: '429' })).toBe(false)
    expect(specLaneSkipsLegacyHandoff({ ...lane, agent: 'shell', ptyChunk: '429' })).toBe(false)
  })
})

describe('readyTaskMustQueue', () => {
  it('queues a ready slice whose CLI is exhausted in this run', () => {
    expect(readyTaskMustQueue(slice({ id: 'a', agent: 'claude' }), ['claude'])).toBe(true)
  })

  it('launches a slice for a CLI that still has credit, a shell, or no exhausted list', () => {
    expect(readyTaskMustQueue(slice({ id: 'a', agent: 'codex' }), ['claude'])).toBe(false)
    expect(readyTaskMustQueue(slice({ id: 'a', agent: 'shell', kind: 'shell' }), ['shell'])).toBe(false)
    expect(readyTaskMustQueue(slice({ id: 'a', agent: 'claude' }), undefined)).toBe(false)
  })
})
