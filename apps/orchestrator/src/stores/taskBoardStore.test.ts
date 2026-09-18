import { describe, expect, it } from 'vitest'

import { createTaskCardDraft } from './taskBoardStore'

describe('createTaskCardDraft', () => {
  it('defaults attachments and toolSelection on new drafts', () => {
    const card = createTaskCardDraft({
      projectId: 'proj_1',
      cwd: '/repo',
      title: ' Draft ',
      prompt: ' Do thing ',
      allowedFiles: ['src/a.ts'],
      priority: 1,
      now: () => 1000,
      createId: () => 'card_1',
    })
    expect(card).toMatchObject({
      id: 'card_1',
      title: 'Draft',
      prompt: 'Do thing',
      attachments: [],
      toolSelection: {
        mode: 'projectDefault',
        mcpServerIds: [],
        skillNames: [],
      },
      createdAt: 1000,
      updatedAt: 1000,
    })
  })

  it('persists provided attachments and toolSelection', () => {
    const attachments = [
      {
        id: 'att_1',
        sourcePath: '/tmp/spec.md',
        storedPath: '/data/spec.md',
        kind: 'handoff' as const,
        title: 'Spec',
      },
    ]
    const toolSelection = {
      mode: 'restrict' as const,
      mcpServerIds: ['figma'],
      skillNames: ['dev'],
    }
    const card = createTaskCardDraft({
      projectId: 'proj_1',
      cwd: '/repo',
      title: 'Task',
      prompt: 'Go',
      allowedFiles: [],
      priority: 2,
      attachments,
      toolSelection,
      now: () => 2000,
      createId: () => 'card_2',
    })
    expect(card.attachments).toEqual(attachments)
    expect(card.toolSelection).toEqual(toolSelection)
  })
})
