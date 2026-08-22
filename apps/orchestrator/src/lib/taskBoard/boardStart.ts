import type { MessageKey } from '../i18n/messages/en'
import type { StartPromptRunResult } from '../promptRun/startPromptRun'
import type { TaskBoardColumn } from '../types'

export type BoardStartCode = Exclude<StartPromptRunResult, { ok: true }>['code']

export type BoardStartFailure = {
  column: Extract<TaskBoardColumn, 'todo' | 'blocked'>
  error: string
}

const ERROR_KEYS: Record<string, MessageKey> = {
  'no-cwd': 'taskBoard.error.noCwd',
  'no-project': 'taskBoard.error.noProject',
  'needs-install': 'taskBoard.error.needsInstall',
  'run-active': 'taskBoard.error.runActive',
  'start-failed': 'taskBoard.error.startFailed',
}

export function decideBoardStartFailure(code: BoardStartCode): BoardStartFailure {
  if (code === 'run-active') return { column: 'todo', error: code }
  return { column: 'blocked', error: code }
}

export function isIgnorableBoardIoError(cause: unknown): boolean {
  const text = cause instanceof Error ? cause.message : String(cause)
  return /command [\w_]+ not found/i.test(text)
}

export function boardInvokeError(cause: unknown): string {
  if (isIgnorableBoardIoError(cause)) return 'start-failed'
  const text = cause instanceof Error ? cause.message : String(cause)
  return text.trim().slice(0, 280) || 'start-failed'
}

export function boardErrorMessageKey(error: string): MessageKey | null {
  return ERROR_KEYS[error] ?? null
}
