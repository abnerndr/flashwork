import { describe, expect, it } from 'vitest'

import { isExtensionIncompatible, isExtensionPathEscape } from './extensions'

describe('extension error sentinels', () => {
  it('detects extension_incompatible in the thrown message', () => {
    expect(isExtensionIncompatible(new Error('extension_incompatible'))).toBe(true)
    expect(isExtensionIncompatible(new Error('openvsx_offline'))).toBe(false)
  })

  it('detects path_escape in the thrown message', () => {
    expect(isExtensionPathEscape('path_escape')).toBe(true)
  })
})
