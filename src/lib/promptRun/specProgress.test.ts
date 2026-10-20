import { describe, expect, it } from 'vitest'

import { formatEta, specProgress } from './specProgress'

describe('specProgress', () => {
  const tasks = [
    { status: 'done' as const, title: 'API' },
    { status: 'running' as const, title: 'Web' },
    { status: 'pending' as const, title: 'Docs' },
    { status: 'failed' as const, title: 'Broken' },
  ]

  it('counts finished tasks toward 100 percent and names the running task', () => {
    const progress = specProgress(tasks, 1_000, 61_000)
    expect(progress).toMatchObject({
      total: 4,
      done: 2,
      remaining: 2,
      percent: 50,
      currentTitle: 'Web',
    })
    expect(progress.etaMs).toBe(60_000)
  })

  it('does not invent an estimate before the first task finishes', () => {
    const progress = specProgress([{ status: 'running', title: 'API' }], 0, 10_000)
    expect(progress.etaMs).toBeNull()
    expect(progress.percent).toBe(0)
    expect(progress.remaining).toBe(1)
  })
})

describe('formatEta', () => {
  it('rounds to minutes and hours', () => {
    expect(formatEta(90_000)).toBe('2m')
    expect(formatEta(3_600_000)).toBe('1h')
    expect(formatEta(5_400_000)).toBe('1h 30m')
  })
})
