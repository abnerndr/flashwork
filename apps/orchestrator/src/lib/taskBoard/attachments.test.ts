import { describe, expect, it } from 'vitest'
import {
  HAND_OFF_EXTENSIONS,
  attachmentTitleFromMarkdown,
  attachmentsDirFor,
  buildTaskBootstrap,
  buildToolsJsonPayload,
  isHandoffPath,
  joinAttachmentsPath,
  resolveToolSelection,
} from './attachments'

describe('attachments', () => {
  it('accepts md markdown mdx only', () => {
    expect(isHandoffPath('/tmp/spec.md')).toBe(true)
    expect(isHandoffPath('/tmp/spec.mdx')).toBe(true)
    expect(isHandoffPath('/tmp/spec.txt')).toBe(false)
  })

  it('reads the first heading as title', () => {
    expect(attachmentTitleFromMarkdown('# Login handoff\n\nDo the thing')).toBe(
      'Login handoff',
    )
    expect(attachmentTitleFromMarkdown('no heading')).toBe('untitled')
  })

  it('buildToolsJsonPayload omits empty allowlists for projectDefault', () => {
    expect(
      buildToolsJsonPayload(
        { mode: 'projectDefault', mcpServerIds: ['x'], skillNames: ['y'] },
        { mcpServerIds: ['a'], skillNames: ['b'] },
      ),
    ).toEqual({ mode: 'projectDefault' })
    expect(
      buildToolsJsonPayload(
        { mode: 'projectDefault', mcpServerIds: [], skillNames: [] },
        { mcpServerIds: ['a'], skillNames: ['b'] },
      ),
    ).toEqual({ mode: 'projectDefault' })
  })

  it('buildToolsJsonPayload writes restrict allowlists from resolveToolSelection', () => {
    expect(
      buildToolsJsonPayload(
        { mode: 'restrict', mcpServerIds: ['figma'], skillNames: ['qa'] },
        { mcpServerIds: ['a'], skillNames: ['b'] },
      ),
    ).toEqual({
      mode: 'restrict',
      mcpServerIds: ['figma'],
      skillNames: ['qa'],
    })
  })

  it('projectDefault ignores ticks; restrict uses the lists', () => {
    expect(
      resolveToolSelection(
        { mode: 'projectDefault', mcpServerIds: ['x'], skillNames: ['y'] },
        { mcpServerIds: ['a'], skillNames: ['b'] },
      ),
    ).toEqual({ mcpServerIds: ['a'], skillNames: ['b'] })
    expect(
      resolveToolSelection(
        { mode: 'restrict', mcpServerIds: ['figma'], skillNames: ['qa'] },
        { mcpServerIds: ['a'], skillNames: ['b'] },
      ),
    ).toEqual({ mcpServerIds: ['figma'], skillNames: ['qa'] })
  })

  it('attachmentsDirFor takes the parent dir of the first attachment, either separator', () => {
    expect(
      attachmentsDirFor([
        { id: 'a1', sourcePath: '/tmp/x.md', storedPath: '/profile/task-board/attachments/card_1/a1-x.md', kind: 'handoff', title: 'x' },
      ]),
    ).toBe('/profile/task-board/attachments/card_1')
    expect(
      attachmentsDirFor([
        {
          id: 'a1',
          sourcePath: 'C:\\tmp\\x.md',
          storedPath: 'C:\\profile\\task-board\\attachments\\card_1\\a1-x.md',
          kind: 'handoff',
          title: 'x',
        },
      ]),
    ).toBe('C:\\profile\\task-board\\attachments\\card_1')
    expect(attachmentsDirFor(undefined)).toBeUndefined()
    expect(attachmentsDirFor([])).toBeUndefined()
  })

  it('joinAttachmentsPath matches the directory separator style', () => {
    expect(joinAttachmentsPath('/profile/attachments/card_1', 'tools.json')).toBe(
      '/profile/attachments/card_1/tools.json',
    )
    expect(joinAttachmentsPath('C:\\profile\\attachments\\card_1', 'tools.json')).toBe(
      'C:\\profile\\attachments\\card_1\\tools.json',
    )
  })

  it('buildTaskBootstrap returns the prompt untouched with no attachments dir', () => {
    expect(buildTaskBootstrap({ prompt: 'implement login' })).toBe('implement login')
  })

  it('buildTaskBootstrap points at paths only, never the attachment markdown body', () => {
    const fakeAttachmentBody = '# Login handoff\n\nSome long transcript body that should never leak.'
    const text = buildTaskBootstrap({
      prompt: 'implement login',
      attachmentsDir: '/profile/task-board/attachments/card_1',
      toolsJsonPath: '/profile/task-board/attachments/card_1/tools.json',
    })
    expect(text).toContain('/profile/task-board/attachments/card_1')
    expect(text).toContain('/profile/task-board/attachments/card_1/tools.json')
    expect(text).toContain('implement login')
    expect(text).not.toContain('# Login handoff')
    expect(text).not.toContain(fakeAttachmentBody)
  })
})
