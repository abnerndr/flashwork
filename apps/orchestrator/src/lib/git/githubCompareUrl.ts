/** Builds `https://github.com/<owner>/<repo>/compare/<branch>?expand=1` from a GitHub remote. */
export function createPullRequestUrl(
  originUrl: string | null | undefined,
  branch: string | null | undefined,
): string | null {
  if (!originUrl || !branch) return null
  return githubCompareUrl(originUrl, branch)
}

export function githubCompareUrl(originUrl: string, branch: string): string | null {
  const ownerRepo = parseGithubOwnerRepo(originUrl)
  const encodedBranch = encodeBranchPath(branch)
  if (!ownerRepo || !encodedBranch) return null
  return `https://github.com/${ownerRepo.owner}/${ownerRepo.repo}/compare/${encodedBranch}?expand=1`
}

function encodeBranchPath(branch: string): string | null {
  const trimmed = branch.trim()
  if (!trimmed) return null
  return trimmed
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

function parseGithubOwnerRepo(originUrl: string): { owner: string; repo: string } | null {
  const trimmed = originUrl.trim()
  if (!trimmed) return null

  const sshScp = trimmed.match(/^git@github\.com:([^/]+)\/(.+)$/i)
  if (sshScp) return ownerRepoFromParts(sshScp[1], sshScp[2])

  try {
    const normalized = trimmed.startsWith('git@') ? trimmed : ensureUrlScheme(trimmed)
    const parsed = new URL(normalized)
    if (!isGithubHost(parsed.hostname)) return null
    const parts = parsed.pathname.split('/').filter(Boolean)
    if (parts.length < 2) return null
    return ownerRepoFromParts(parts[0], parts[1])
  } catch {
    return null
  }
}

function ensureUrlScheme(value: string): string {
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)) return value
  return `https://${value}`
}

function isGithubHost(hostname: string): boolean {
  return hostname.toLowerCase() === 'github.com'
}

function ownerRepoFromParts(owner: string, repoRaw: string): { owner: string; repo: string } | null {
  const repo = repoRaw.replace(/\.git$/i, '').replace(/\/+$/, '')
  if (!owner || !repo || repo.includes('/')) return null
  return { owner, repo }
}
