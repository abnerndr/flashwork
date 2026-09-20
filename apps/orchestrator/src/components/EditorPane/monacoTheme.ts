import type { Theme } from '../../lib/types'

export type MonacoBuiltinTheme = 'vs' | 'vs-dark'

/** Map Flashwork UI themes onto Monaco's built-in palettes. */
export function monacoThemeFor(theme: Theme): MonacoBuiltinTheme {
  if (theme === 'light' || theme === 'min-light') return 'vs'
  return 'vs-dark'
}
