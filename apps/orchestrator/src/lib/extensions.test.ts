import { describe, expect, it } from 'vitest'

import {
  isExtensionIncompatible,
  isExtensionMalformed,
  isExtensionPathEscape,
  isExtensionTooLarge,
} from './extensions'

describe('extension error sentinels', () => {
  it('detects extension_incompatible in the thrown message', () => {
    expect(isExtensionIncompatible(new Error('extension_incompatible'))).toBe(true)
    expect(isExtensionIncompatible(new Error('openvsx_offline'))).toBe(false)
  })

  it('detects path_escape in the thrown message', () => {
    expect(isExtensionPathEscape('path_escape')).toBe(true)
  })

  it('detects openvsx_malformed and openvsx_too_large', () => {
    expect(isExtensionMalformed(new Error('openvsx_malformed'))).toBe(true)
    expect(isExtensionTooLarge(new Error('openvsx_too_large'))).toBe(true)
    expect(isExtensionMalformed(new Error('openvsx_too_large'))).toBe(false)
    expect(isExtensionTooLarge(new Error('openvsx_malformed'))).toBe(false)
  })
})
