import { describe, expect, it } from 'vitest'

import { decideLaneFailure } from './laneFailure'

describe('decideLaneFailure', () => {
  it('hands the whole run off when the failed pane is the only worker', () => {
    expect(
      decideLaneFailure({
        liveStepCount: 1,
        failedKind: 'implement',
        siblingKinds: [],
        trigger: 'error',
      }),
    ).toBe('handoff-run')
  })

  it('drops a failed login pane when a sibling already owns the same kind', () => {
    expect(
      decideLaneFailure({
        liveStepCount: 2,
        failedKind: 'implement',
        siblingKinds: ['implement'],
        trigger: 'error',
      }),
    ).toBe('drop-lane')
  })

  it('retargets only that slice when a unique sibling kind fails', () => {
    expect(
      decideLaneFailure({
        liveStepCount: 2,
        failedKind: 'mechanical',
        siblingKinds: ['implement'],
        trigger: 'error',
      }),
    ).toBe('retarget-slice')
  })

  it('drops a login/auth pane even when the sibling kind differs', () => {
    expect(
      decideLaneFailure({
        liveStepCount: 2,
        failedKind: 'review',
        siblingKinds: ['implement'],
        trigger: 'error',
        loginBlocked: true,
      }),
    ).toBe('drop-lane')
  })
})
