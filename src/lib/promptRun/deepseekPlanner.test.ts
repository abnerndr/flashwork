import { describe, expect, it } from 'vitest'

import { MODEL_CATALOG } from '../providers/modelCatalog'
import { isImplementationHeavySpec, pickDeepseekPlannerModel } from './deepseekPlanner'

const models = MODEL_CATALOG.deepseek

describe('pickDeepseekPlannerModel', () => {
  it('uses the router model for a short or non-coding SPEC', () => {
    const spec = 'Review the README and summarize the architecture for the team.'
    expect(isImplementationHeavySpec(spec)).toBe(false)
    expect(pickDeepseekPlannerModel(spec, models)).toBe('deepseek-flash')
  })

  it('uses the coder-class model when the SPEC is clearly implementation work', () => {
    const spec = [
      'Implement the login API and the session store.',
      'Add unit tests for the auth component.',
      'Refactor token refresh so expired sessions redirect to the login screen.',
    ].join('\n')
    expect(isImplementationHeavySpec(spec)).toBe(true)
    expect(pickDeepseekPlannerModel(spec, models)).toBe('deepseek-v4-pro')
  })

  it('stays on the router model when coding words appear only once', () => {
    const spec =
      'Review the design notes. Mention how we might implement login later, but do not change code in this pass. ' +
      'The audience is the team reading the architecture doc, not an agent writing files.'
    expect(isImplementationHeavySpec(spec)).toBe(false)
    expect(pickDeepseekPlannerModel(spec, models)).toBe('deepseek-flash')
  })
})
