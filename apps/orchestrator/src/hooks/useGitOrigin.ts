import { useCallback, useEffect, useRef, useState } from 'react'

import { gitRemoteGet } from '../lib/tauri'

export function useGitOrigin(projectId: string, repoRoot: string | undefined) {
  const [originUrl, setOriginUrl] = useState<string | null>(null)
  const [originInput, setOriginInput] = useState('')
  const repoRootRef = useRef(repoRoot)
  repoRootRef.current = repoRoot

  const refreshOrigin = useCallback(async (root: string | undefined) => {
    if (!root) {
      setOriginUrl(null)
      return
    }
    try {
      const url = await gitRemoteGet(root, 'origin')
      if (repoRootRef.current !== root) return
      setOriginUrl(url)
    } catch {
      if (repoRootRef.current !== root) return
      setOriginUrl(null)
    }
  }, [])

  useEffect(() => {
    setOriginUrl(null)
    setOriginInput('')
    if (!repoRoot) return
    let cancelled = false
    void gitRemoteGet(repoRoot, 'origin')
      .then((url) => {
        if (!cancelled) setOriginUrl(url)
      })
      .catch(() => {
        if (!cancelled) setOriginUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, repoRoot])

  return { originUrl, originInput, setOriginInput, refreshOrigin }
}
