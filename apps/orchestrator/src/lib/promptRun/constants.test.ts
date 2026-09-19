import { describe, expect, it } from 'vitest'

import { AUTO_LAUNCH_VALUE, HOME_DEFAULT_QUICK_PICK } from './constants'

describe('prompt-run constants', () => {
  it('defaults the Home quick pick to Auto', () => {
    expect(HOME_DEFAULT_QUICK_PICK).toBe('auto')
    expect(HOME_DEFAULT_QUICK_PICK).toBe(AUTO_LAUNCH_VALUE)
  })
})
