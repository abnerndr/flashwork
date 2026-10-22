import { describe, expect, it } from 'vitest'

import { formatEta, specProgress } from './specProgress'

describe('specProgress', () => {
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
