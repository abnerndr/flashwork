import { describe, expect, it } from 'vitest'

import { workspaceRelFromAbs } from './workspaceRel'

describe('workspaceRelFromAbs', () => {
  it('returns a posix relative path for a file inside the root', () => {
    expect(workspaceRelFromAbs('/proj', '/proj/src/main.ts')).toBe('src/main.ts')
  })

  it('returns nested relative paths with forward slashes', () => {
    expect(workspaceRelFromAbs('/proj', '/proj/a/b/c.ts')).toBe('a/b/c.ts')
  })

  it('returns null when the path is outside the root', () => {
    expect(workspaceRelFromAbs('/proj', '/other/src/main.ts')).toBeNull()
  })

  it('returns null when a sibling prefix shares the root name', () => {
    expect(workspaceRelFromAbs('/proj', '/proj-extra/src/main.ts')).toBeNull()
  })

  it('returns null when the path walks above the root with ..', () => {
    expect(workspaceRelFromAbs('/proj', '/proj/../secret/x.ts')).toBeNull()
  })

  it('returns null when a nested .. escapes the root', () => {
    expect(workspaceRelFromAbs('/proj', '/proj/src/../../outside.ts')).toBeNull()
  })

  it('returns null for the root itself', () => {
    expect(workspaceRelFromAbs('/proj', '/proj')).toBeNull()
  })

  it('maps a git-relative path after joining it to the repository root', () => {
    const repoRoot = '/work/repo'
    const gitRel = 'src/lib/main.ts'
    const abs = `${repoRoot}/${gitRel}`
    expect(workspaceRelFromAbs(repoRoot, abs)).toBe(gitRel)
  })

  it('returns null when the joined repo path sits outside a nested editor cwd', () => {
    const repoRoot = '/work/repo'
    const editorCwd = '/work/repo/apps/orchestrator'
    expect(workspaceRelFromAbs(editorCwd, `${repoRoot}/package.json`)).toBeNull()
  })
})
