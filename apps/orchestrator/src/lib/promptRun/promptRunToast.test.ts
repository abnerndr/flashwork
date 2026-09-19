import { describe, expect, it } from 'vitest'

import { promptRunOutcomeToast } from './promptRunToast'

describe('promptRunOutcomeToast', () => {
  it('uses finished copy when the run is already done', () => {
    expect(promptRunOutcomeToast('done')).toEqual({
      titleKey: 'promptRun.finishedTitle',
      bodyKey: 'promptRun.finishedBody',
    })
  })

  it('uses started copy while a CLI run is still live', () => {
    expect(promptRunOutcomeToast('running')).toEqual({
      titleKey: 'promptRun.startedTitle',
      bodyKey: 'promptRun.startedBody',
    })
  })
})
