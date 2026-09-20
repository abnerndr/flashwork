import { describe, expect, it } from 'vitest'

import type { Theme } from '../../lib/types'
import { monacoThemeFor } from './monacoTheme'

const LIGHT: Theme[] = ['light', 'min-light']
const DARK: Theme[] = [
  'dark',
  'dracula',
  'nord',
  'gruvbox',
  'solarized',
  'tokyo-night',
  'vscode',
  'min-dark',
  'dark-lemon',
  'orca',
  'ember',
  'golden-premium',
]

describe('monacoThemeFor', () => {
  it('maps light and min-light to vs', () => {
    for (const theme of LIGHT) {
      expect(monacoThemeFor(theme)).toBe('vs')
    }
  })

  it('maps vscode to vs-dark', () => {
    expect(monacoThemeFor('vscode')).toBe('vs-dark')
  })

  it('maps every other Flashwork theme to vs-dark', () => {
    for (const theme of DARK) {
      expect(monacoThemeFor(theme)).toBe('vs-dark')
    }
  })
})
