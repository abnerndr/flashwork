import { invoke } from '@tauri-apps/api/core'

import { pickFiles } from '../dialog'
import type { TaskAttachment } from '../types'

export const MARKDOWN_DIALOG_FILTERS = [
  { name: 'Markdown', extensions: ['md', 'markdown', 'mdx'] },
]

/**
 * Copies a markdown handoff file into the Task Board's attachments
 * directory for the given card and returns the resulting attachment
 * record. Does not require the card to already exist in `task-board.json` —
 * the caller (composer draft) merges the attachment before saving.
 */
export function taskAttachMarkdown(cardId: string, sourcePath: string): Promise<TaskAttachment> {
  return invoke<TaskAttachment>('task_attach_markdown', { cardId, sourcePath })
}

/**
 * Opens a markdown file picker and, if the user selects one or more files,
 * attaches each of them to the given card sequentially. Returns the
 * resulting attachment records in selection order.
 */
export async function pickAndAttachMarkdown(cardId: string): Promise<TaskAttachment[]> {
  const paths = await pickFiles({ filters: MARKDOWN_DIALOG_FILTERS })
  if (!paths || paths.length === 0) return []
  const attachments: TaskAttachment[] = []
  for (const path of paths) {
    attachments.push(await taskAttachMarkdown(cardId, path))
  }
  return attachments
}
