import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { gitRemoteGet } = vi.hoisted(() => ({
  gitRemoteGet: vi.fn(),
}))

vi.mock('../lib/tauri', () => ({
  gitRemoteGet,
}))

import { useGitOrigin } from './useGitOrigin'

describe('useGitOrigin', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('clears typed origin input when the repository changes', async () => {
    gitRemoteGet.mockResolvedValue(null)
    const { result, rerender } = renderHook(
      ({ projectId, repoRoot }: { projectId: string; repoRoot: string | undefined }) =>
        useGitOrigin(projectId, repoRoot),
      { initialProps: { projectId: 'a', repoRoot: '/repo-a' } },
    )

    await waitFor(() => {
      expect(gitRemoteGet).toHaveBeenCalledWith('/repo-a', 'origin')
    })

    act(() => {
      result.current.setOriginInput('https://github.com/acme/a.git')
    })
    expect(result.current.originInput).toBe('https://github.com/acme/a.git')

    gitRemoteGet.mockResolvedValue('https://github.com/acme/b.git')
    rerender({ projectId: 'b', repoRoot: '/repo-b' })

    expect(result.current.originInput).toBe('')
    expect(result.current.originUrl).toBeNull()

    await waitFor(() => {
      expect(result.current.originUrl).toBe('https://github.com/acme/b.git')
    })
  })

  it('ignores a stale gitRemoteGet after the repository changes', async () => {
    let resolveA: (value: string | null) => void = () => undefined
    gitRemoteGet.mockImplementation((root: string) => {
      if (root === '/repo-a') {
        return new Promise<string | null>((resolve) => {
          resolveA = resolve
        })
      }
      return Promise.resolve('https://github.com/acme/b.git')
    })

    const { result, rerender } = renderHook(
      ({ projectId, repoRoot }: { projectId: string; repoRoot: string | undefined }) =>
        useGitOrigin(projectId, repoRoot),
      { initialProps: { projectId: 'a', repoRoot: '/repo-a' } },
    )

    rerender({ projectId: 'b', repoRoot: '/repo-b' })

    await waitFor(() => {
      expect(result.current.originUrl).toBe('https://github.com/acme/b.git')
    })

    await act(async () => {
      resolveA('https://github.com/acme/a.git')
    })

    expect(result.current.originUrl).toBe('https://github.com/acme/b.git')
    expect(result.current.originInput).toBe('')
  })
})
