import { describe, expect, it } from 'vitest'

import { SCM_GROUP_ORDER, scmMoreMenuEntries } from './scmLayout'

describe('SCM_GROUP_ORDER', () => {
  it('lists Staged, Changes, Untracked, then Conflicts', () => {
    expect(SCM_GROUP_ORDER).toEqual(['staged', 'changes', 'untracked', 'conflicts'])
  })
})

describe('scmMoreMenuEntries', () => {
  it('starts with Fetch, Pull, Push, and Publish', () => {
    const ids = scmMoreMenuEntries({ showOpenPullRequest: false, showSignIn: false })
      .filter((entry) => entry.kind === 'item')
      .map((entry) => entry.id)
    expect(ids).toEqual(['fetch', 'pull', 'push', 'publish'])
  })

  it('appends Open pull request and Sign in after a separator', () => {
    expect(scmMoreMenuEntries({ showOpenPullRequest: true, showSignIn: true })).toEqual([
      { kind: 'item', id: 'fetch' },
      { kind: 'item', id: 'pull' },
      { kind: 'item', id: 'push' },
      { kind: 'item', id: 'publish' },
      { kind: 'separator' },
      { kind: 'item', id: 'openPullRequest' },
      { kind: 'item', id: 'signIn' },
    ])
  })

  it('omits extras that are not available', () => {
    expect(scmMoreMenuEntries({ showOpenPullRequest: true, showSignIn: false })).toEqual([
      { kind: 'item', id: 'fetch' },
      { kind: 'item', id: 'pull' },
      { kind: 'item', id: 'push' },
      { kind: 'item', id: 'publish' },
      { kind: 'separator' },
      { kind: 'item', id: 'openPullRequest' },
    ])
  })
})
