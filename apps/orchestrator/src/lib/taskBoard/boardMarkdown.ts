import { AGENT_TYPE_LABELS } from '../types'
import type { TaskCard, TaskSlicePlan } from '../types'

export function renderBoardMarkdown(card: Pick<TaskCard, 'title' | 'prompt' | 'allowedFiles'>, slices: readonly TaskSlicePlan[]): string {
  const files =
    card.allowedFiles.length > 0
      ? card.allowedFiles.map((file) => `- ${file}`).join('\n')
      : '- (whole repository)'
  const roster = slices
    .map((slice) => {
      const deps = slice.dependsOn.length ? ` depends on ${slice.dependsOn.join(', ')}` : ''
      return `- ${slice.id} · ${AGENT_TYPE_LABELS[slice.agent]} · ${slice.kind} · ${slice.status}${deps}`
    })
    .join('\n')
  return [
    `# ${card.title}`,
    '',
    '## Request',
    '',
    card.prompt,
    '',
    '## Allowed files',
    '',
    files,
    '',
    '## Slices',
    '',
    roster || '- (none)',
    '',
    '## Notes',
    '',
    'Workers append findings below. Do not redo a sibling slice.',
    '',
  ].join('\n')
}

export function appendBoardNote(existing: string, heading: string, body: string): string {
  const entry = `## ${heading}\n\n${body}`
  if (!existing.trim()) return entry
  const prefix = existing.endsWith('\n') ? existing : `${existing}\n`
  return `${prefix}\n${entry}`
}
