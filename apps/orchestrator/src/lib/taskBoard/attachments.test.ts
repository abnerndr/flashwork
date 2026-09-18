import { describe, expect, it } from 'vitest'
import {
  HAND_OFF_EXTENSIONS,
  attachmentTitleFromMarkdown,
  isHandoffPath,
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
})
