import { describe, expect, it } from 'vitest'

import { resolveEditorOpenRel } from './openInEditor'

/** Same join GitControl uses before calling `openSourceInEditor`. */
function absoluteRepoPath(repoRoot: string, relativePath: string): string {
  if (/^(?:[A-Za-z]:[\\/]|\/)/.test(relativePath)) return relativePath
  const separator = repoRoot.includes('\\') ? '\\' : '/'
  return `${repoRoot.replace(/[\\/]+$/, '')}${separator}${relativePath.replace(/^[\\/]+/, '').replace(/[\\/]/g, separator)}`
}

describe('resolveEditorOpenRel', () => {
  it('maps an absolute join of repoRoot + git-rel when the editor cwd is the repo root', () => {
    const repoRoot = '/work/repo'
    const abs = absoluteRepoPath(repoRoot, 'src/lib/main.ts')
    expect(abs).toBe('/work/repo/src/lib/main.ts')
    expect(resolveEditorOpenRel(repoRoot, abs)).toBe('src/lib/main.ts')
  })

  it('returns null when the joined repo path sits outside a nested editor cwd', () => {
    const repoRoot = '/work/repo'
    const editorCwd = '/work/repo/apps/orchestrator'
    const abs = absoluteRepoPath(repoRoot, 'package.json')
    expect(resolveEditorOpenRel(editorCwd, abs)).toBeNull()
  })

  it('keeps a raw git-relative path as cwd-relative (why GitControl must join first)', () => {
    expect(resolveEditorOpenRel('/work/repo/apps/orchestrator', 'src/lib/main.ts')).toBe(
      'src/lib/main.ts',
    )
  })
})
