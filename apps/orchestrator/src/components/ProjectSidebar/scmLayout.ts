export const SCM_GROUP_ORDER = ['staged', 'changes', 'untracked', 'conflicts'] as const

export type ScmGroupKind = (typeof SCM_GROUP_ORDER)[number]

export type ScmMoreMenuItemId = 'fetch' | 'pull' | 'push' | 'publish' | 'openPullRequest' | 'signIn'

export type ScmMoreMenuEntry = { kind: 'item'; id: ScmMoreMenuItemId; disabled: boolean } | { kind: 'separator' }

export type ScmMoreMenuOptions = {
  showOpenPullRequest: boolean
  showSignIn: boolean
  detached?: boolean
  canPublish?: boolean
  busy?: boolean
}

function scmMoreMenuItemDisabled(
  id: ScmMoreMenuItemId,
  options: { detached: boolean; canPublish: boolean; busy: boolean },
): boolean {
  if (options.busy) return true
  if (id === 'pull' || id === 'push') return options.detached
  if (id === 'publish') return options.detached || !options.canPublish
  return false
}

export function scmMoreMenuEntries(options: ScmMoreMenuOptions): ScmMoreMenuEntry[] {
  const detached = Boolean(options.detached)
  const canPublish = options.canPublish !== false
  const busy = Boolean(options.busy)

  const item = (id: ScmMoreMenuItemId): ScmMoreMenuEntry => ({
    kind: 'item',
    id,
    disabled: scmMoreMenuItemDisabled(id, { detached, canPublish, busy }),
  })

  const entries: ScmMoreMenuEntry[] = [item('fetch'), item('pull'), item('push'), item('publish')]
  if (options.showOpenPullRequest || options.showSignIn) {
    entries.push({ kind: 'separator' })
  }
  if (options.showOpenPullRequest) {
    entries.push(item('openPullRequest'))
  }
  if (options.showSignIn) {
    entries.push(item('signIn'))
  }
  return entries
}
