import { describe, expect, it } from 'vitest'

import { CHUNK_CHAR_CAP, searchChunks, splitExtractiveChunks } from './contextChunks'

describe('splitExtractiveChunks', () => {
  it('keeps turns that touch the same file in one chunk', () => {
    const chunks = splitExtractiveChunks(
      [
        { role: 'user', text: 'fix auth', files: ['src/auth.ts'] },
        { role: 'assistant', text: 'editing login', files: ['src/auth.ts'] },
      ],
      'sess-1',
      'claude',
    )
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.files).toEqual(['src/auth.ts'])
    expect(chunks[0]?.text).toContain('fix auth')
  })

  it('splits when the char cap would be exceeded', () => {
    const chunks = splitExtractiveChunks(
      [
        { role: 'user', text: 'a'.repeat(CHUNK_CHAR_CAP), files: ['a.ts'] },
        { role: 'user', text: 'next', files: ['a.ts'] },
      ],
      'sess-1',
      'claude',
    )
    expect(chunks.length).toBeGreaterThanOrEqual(2)
  })
})

describe('searchChunks', () => {
  it('prefers file hits and stays inside the byte budget', () => {
    const chunks = splitExtractiveChunks(
      [
        { role: 'user', text: 'auth work', files: ['src/auth.ts'] },
        { role: 'user', text: 'unrelated ui', files: ['src/ui.ts'] },
      ],
      'sess-1',
      'claude',
    )
    const found = searchChunks(chunks, { file: 'src/auth.ts', terms: ['auth'] }, 8192)
    expect(found[0]?.files).toContain('src/auth.ts')
    expect(found.some((chunk) => chunk.files.includes('src/ui.ts'))).toBe(false)
  })
})
