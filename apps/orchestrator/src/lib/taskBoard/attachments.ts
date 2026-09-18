import type { TaskToolSelection } from '../types'

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
