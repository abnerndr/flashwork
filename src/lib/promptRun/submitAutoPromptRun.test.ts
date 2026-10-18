import { describe, expect, it } from 'vitest'

import { lanesFromRoutedChoice } from './submitAutoPromptRun'

describe('lanesFromRoutedChoice', () => {
  it('always builds one worker lane from a CLI route', () => {
    const lanes = lanesFromRoutedChoice(
      { agent: 'codex', taskKind: 'mechanical', reason: 'heuristic' },
      'write tests',
    )
    expect(lanes).toEqual([
      {
        agent: 'codex',
        role: 'worker',
        taskKind: 'mechanical',
        reason: 'heuristic',
        skillNames: [],
        slicePrompt: 'write tests',
      },
    ])
  })

  it('always builds one worker lane from an api route', () => {
    const lanes = lanesFromRoutedChoice(
      { agent: 'api:google', taskKind: 'implement', reason: 'heuristic' },
      'implement login',
    )
    expect(lanes).toHaveLength(1)
    expect(lanes[0]?.agent).toBe('api:google')
    expect(lanes[0]?.role).toBe('worker')
  })
})
