export const SCM_GROUP_ORDER = ['staged', 'changes', 'untracked', 'conflicts'] as const

export type ScmGroupKind = (typeof SCM_GROUP_ORDER)[number]

export type ScmMoreMenuItemId = 'fetch' | 'pull' | 'push' | 'publish' | 'openPullRequest' | 'signIn'

export type ScmMoreMenuEntry = { kind: 'item'; id: ScmMoreMenuItemId } | { kind: 'separator' }

export function scmMoreMenuEntries(options: {
  showOpenPullRequest: boolean
  showSignIn: boolean
}): ScmMoreMenuEntry[] {
  const entries: ScmMoreMenuEntry[] = [
    { kind: 'item', id: 'fetch' },
    { kind: 'item', id: 'pull' },
    { kind: 'item', id: 'push' },
    { kind: 'item', id: 'publish' },
  ]
  if (options.showOpenPullRequest || options.showSignIn) {
    entries.push({ kind: 'separator' })
  }
  if (options.showOpenPullRequest) {
    entries.push({ kind: 'item', id: 'openPullRequest' })
  }
  if (options.showSignIn) {
    entries.push({ kind: 'item', id: 'signIn' })
  }
  return entries
}
