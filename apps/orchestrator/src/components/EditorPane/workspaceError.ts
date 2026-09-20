import { messageOf } from '../../lib/errors'
import type { MessageKey } from '../../lib/i18n'

export function workspaceErrorKey(
  error: unknown,
  fallback: Extract<MessageKey, 'editor.errReadFailed' | 'editor.errWriteFailed' | 'editor.errListFailed'>,
): MessageKey {
  const message = messageOf(error)
  if (message.includes('file_too_large')) return 'editor.errFileTooLarge'
  if (message.includes('path_escape')) return 'editor.errPathEscape'
  return fallback
}

export function isFileTooLarge(error: unknown): boolean {
  return messageOf(error).includes('file_too_large')
}
