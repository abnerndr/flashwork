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

  it('lists attachment titles and stored paths', () => {
    const markdown = renderBoardMarkdown(
      {
        title: 'Handoff task',
        prompt: 'continue work',
        allowedFiles: [],
        attachments: [
          {
            id: 'att_1',
            sourcePath: '/tmp/handoff.md',
            storedPath: '/x.md',
            kind: 'handoff',
            title: 'Handoff',
          },
        ],
      },
      [],
    )
    expect(markdown).toContain('Handoff')
    expect(markdown).toContain('/x.md')
  })

  it('lists restricted skill names and mcp server ids', () => {
    const markdown = renderBoardMarkdown(
      {
        title: 'Restricted tools',
        prompt: 'run with limits',
        allowedFiles: [],
        toolSelection: {
          mode: 'restrict',
          mcpServerIds: ['figma'],
          skillNames: ['qa-validacao-tasks', 'dev'],
        },
      },
      [],
    )
    expect(markdown).toContain('qa-validacao-tasks')
    expect(markdown).toContain('dev')
    expect(markdown).toContain('figma')
    expect(markdown).toContain('Restricted to selected MCP servers and skills.')
  })

  it('notes project default tools when mode is projectDefault', () => {
    const markdown = renderBoardMarkdown(
      {
        title: 'Default tools',
        prompt: 'use defaults',
        allowedFiles: [],
        toolSelection: {
          mode: 'projectDefault',
          mcpServerIds: [],
          skillNames: [],
        },
      },
      [],
    )
    expect(markdown).toContain('Uses project default MCP servers and skills.')
  })
})
