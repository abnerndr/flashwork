import { describe, expect, it } from 'vitest'

import { renderBoardMarkdown } from './boardMarkdown'

describe('renderBoardMarkdown', () => {
  it('lists slices and allowed files so sibling workers can share context', () => {
    const markdown = renderBoardMarkdown(
      { title: 'Login', prompt: 'implement login', allowedFiles: ['src/auth.ts'] },
      [
        {
          id: 'slice_1',
          kind: 'implement',
          agent: 'claude',
          prompt: 'impl',
          dependsOn: [],
          allowedFiles: ['src/auth.ts'],
          status: 'running',
        },
        {
          id: 'slice_2',
          kind: 'review',
          agent: 'gemini',
          prompt: 'review',
          dependsOn: ['slice_1'],
          allowedFiles: ['src/auth.ts'],
          status: 'pending',
        },
      ],
    )
    expect(markdown).toContain('src/auth.ts')
    expect(markdown).toContain('Claude Code')
    expect(markdown).toContain('depends on slice_1')
    expect(markdown).not.toContain('Freebuff')
  })
})
