/** Reuse the Canvas quota idea without importing Canvas modules. */
export const QUOTA_HANDOFF_THRESHOLD = 80

export const JOURNAL_CHAR_LIMIT = 48_000

export const AUTO_LAUNCH_VALUE = 'auto' as const

export type AutoLaunchValue = typeof AUTO_LAUNCH_VALUE

export const PROMPT_RUN_HANDOFF_PAIR: ReadonlyArray<'claude' | 'codex'> = ['claude', 'codex']
