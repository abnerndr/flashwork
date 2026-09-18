import { describe, expect, it } from 'vitest'

import { pickUsableSessionId, savedConversationIdFor, type SavedSession } from './sessionResume'

const baseSession: SavedSession = {
  sessionId: 'pty-1',
  claudeSessionId: 'claude-chat',
  codexSessionId: 'codex-chat',
  antigravitySessionId: 'antigravity-chat',
  cwd: 'D:\\Work\\Project',
  agent: 'claude',
  timestamp: 1000,
}

describe('savedConversationIdFor', () => {
  it('returns the saved Claude id when agent and cwd match', () => {
    expect(savedConversationIdFor(baseSession, 'claude', 'D:/Work/Project/')).toBe('claude-chat')
  })

  it('ignores saved sessions from another agent', () => {
    expect(savedConversationIdFor(baseSession, 'codex', 'D:/Work/Project')).toBeUndefined()
  })

  it('ignores saved sessions from another cwd', () => {
    expect(savedConversationIdFor(baseSession, 'claude', 'D:/Work/Other')).toBeUndefined()
  })

  it('returns the saved Antigravity conversation id', () => {
    expect(
      savedConversationIdFor(
        { ...baseSession, agent: 'antigravity' },
        'antigravity',
        'D:/Work/Project',
      ),
    ).toBe('antigravity-chat')
  })

  it('returns the saved OpenCode session id', () => {
    expect(
      savedConversationIdFor(
        { ...baseSession, agent: 'opencode', opencodeSessionId: 'opencode-chat' },
        'opencode',
        'D:/Work/Project',
      ),
    ).toBe('opencode-chat')
  })

  it('returns the saved Gemini session id', () => {
    expect(
      savedConversationIdFor(
        { ...baseSession, agent: 'gemini', geminiSessionId: 'gemini-chat' },
        'gemini',
        'D:/Work/Project',
      ),
    ).toBe('gemini-chat')
  })
})

describe('pickUsableSessionId', () => {
  const sessions = [
    { id: 'alive', size_bytes: 1200 },
    { id: 'empty', size_bytes: 0 },
  ]

  it('keeps an id that still has a non-empty transcript', () => {
    expect(pickUsableSessionId(sessions, 'alive')).toBe('alive')
  })

  it('drops missing and empty transcripts so Claude does not get --resume on a ghost id', () => {
    expect(pickUsableSessionId(sessions, 'e0d0623d-288b-4b0a-a16d-8ed4afd20240')).toBeUndefined()
    expect(pickUsableSessionId(sessions, 'empty')).toBeUndefined()
    expect(pickUsableSessionId(sessions, undefined)).toBeUndefined()
  })
})
