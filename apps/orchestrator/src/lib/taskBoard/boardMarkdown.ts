import { AGENT_TYPE_LABELS } from '../types'
import type { TaskCard, TaskSlicePlan } from '../types'

export function renderBoardMarkdown(
  card: Pick<TaskCard, 'title' | 'prompt' | 'allowedFiles' | 'attachments' | 'toolSelection'>,
  slices: readonly TaskSlicePlan[],
): string {
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

  const sections: string[] = [
    `# ${card.title}`,
    '',
    '## Request',
    '',
    card.prompt,
    '',
  ]

  if (card.attachments && card.attachments.length > 0) {
    sections.push(
      '## Attachments',
      '',
      card.attachments.map((attachment) => `- ${attachment.title} · ${attachment.storedPath}`).join('\n'),
      '',
    )
  }

  sections.push('## Allowed files', '', files, '')

  const toolSelection = card.toolSelection ?? {
    mode: 'projectDefault' as const,
    mcpServerIds: [],
    skillNames: [],
  }
  sections.push('## Tools', '')
  if (toolSelection.mode === 'restrict') {
    const skills =
      toolSelection.skillNames.length > 0
        ? toolSelection.skillNames.map((name) => `- ${name}`).join('\n')
        : '- (none)'
    const servers =
      toolSelection.mcpServerIds.length > 0
        ? toolSelection.mcpServerIds.map((id) => `- ${id}`).join('\n')
        : '- (none)'
    sections.push('Restricted to selected MCP servers and skills.', '', 'Skills:', '', skills, '', 'MCP servers:', '', servers, '')
  } else {
    sections.push('Uses project default MCP servers and skills.', '')
  }

  sections.push(
    '## Slices',
    '',
    roster || '- (none)',
    '',
    '## Notes',
    '',
    'Workers append findings below. Do not redo a sibling slice.',
    '',
  )

  return sections.join('\n')
}

export function appendBoardNote(existing: string, heading: string, body: string): string {
  const entry = `## ${heading}\n\n${body}`
  if (!existing.trim()) return entry
  const prefix = existing.endsWith('\n') ? existing : `${existing}\n`
  return `${prefix}\n${entry}`
}
