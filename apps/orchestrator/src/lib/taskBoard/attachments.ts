import type { TaskAttachment, TaskToolSelection } from '../types'

export const HAND_OFF_EXTENSIONS = ['.md', '.markdown', '.mdx'] as const

export function isHandoffPath(path: string): boolean {
  const lower = path.toLowerCase()
  return HAND_OFF_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

export function attachmentTitleFromMarkdown(body: string): string {
  const match = body.match(/^#\s+(.+)$/m)
  const title = match?.[1]?.trim()
  return title && title.length > 0 ? title : 'untitled'
}

export type ToolSelection = TaskToolSelection

export function resolveToolSelection(
  selection: ToolSelection,
  projectDefaults: { mcpServerIds: string[]; skillNames: string[] },
): { mcpServerIds: string[]; skillNames: string[] } {
  if (selection.mode !== 'restrict') return projectDefaults
  return { mcpServerIds: [...selection.mcpServerIds], skillNames: [...selection.skillNames] }
}

/**
 * Parent directory of a stored attachment path (cross-platform: accepts
 * `/` or `\` separators, since attachments can be spawned on Windows).
 * Returns `undefined` when there are no attachments.
 */
export function attachmentsDirFor(attachments?: readonly TaskAttachment[]): string | undefined {
  const first = attachments?.[0]
  if (!first?.storedPath) return undefined
  const cleaned = first.storedPath.replace(/[\\/]+$/, '')
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'))
  return idx > 0 ? cleaned.slice(0, idx) : cleaned
}

/** Joins a file name onto a directory using that directory's own separator style. */
export function joinAttachmentsPath(dir: string, fileName: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  return `${dir}${sep}${fileName}`
}

/**
 * Builds pointer-only bootstrap text for a worker: absolute paths to the
 * attachment directory and the resolved tools JSON, followed by the
 * card prompt. Never inlines attachment file bodies (headings, markdown,
 * etc.) — workers are expected to read the files themselves on disk.
 */
export function buildTaskBootstrap(args: {
  prompt: string
  attachmentsDir?: string
  toolsJsonPath?: string
}): string {
  if (!args.attachmentsDir) return args.prompt
  const lines = ['Task attachments are on disk. Read them:', args.attachmentsDir]
  if (args.toolsJsonPath) {
    lines.push(`Selected tools (JSON): ${args.toolsJsonPath}`)
  }
  lines.push('', args.prompt)
  return lines.join('\n')
}
