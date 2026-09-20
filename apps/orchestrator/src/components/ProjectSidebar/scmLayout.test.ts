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
      { kind: 'item', id: 'fetch', disabled: false },
      { kind: 'item', id: 'pull', disabled: false },
      { kind: 'item', id: 'push', disabled: false },
      { kind: 'item', id: 'publish', disabled: false },
      { kind: 'separator' },
      { kind: 'item', id: 'openPullRequest', disabled: false },
      { kind: 'item', id: 'signIn', disabled: false },
    ])
  })

  it('omits extras that are not available', () => {
    expect(scmMoreMenuEntries({ showOpenPullRequest: true, showSignIn: false })).toEqual([
      { kind: 'item', id: 'fetch', disabled: false },
      { kind: 'item', id: 'pull', disabled: false },
      { kind: 'item', id: 'push', disabled: false },
      { kind: 'item', id: 'publish', disabled: false },
      { kind: 'separator' },
      { kind: 'item', id: 'openPullRequest', disabled: false },
    ])
  })

  it('disables Pull, Push, and Publish on detached HEAD; Fetch stays enabled', () => {
    const flags = Object.fromEntries(
      scmMoreMenuEntries({
        showOpenPullRequest: false,
        showSignIn: false,
        detached: true,
        canPublish: true,
      })
        .filter((entry) => entry.kind === 'item')
        .map((entry) => [entry.id, entry.disabled]),
    )
    expect(flags).toEqual({
      fetch: false,
      pull: true,
      push: true,
      publish: true,
    })
  })

  it('disables Publish when the branch cannot be published', () => {
    const flags = Object.fromEntries(
      scmMoreMenuEntries({
        showOpenPullRequest: false,
        showSignIn: false,
        canPublish: false,
      })
        .filter((entry) => entry.kind === 'item')
        .map((entry) => [entry.id, entry.disabled]),
    )
    expect(flags).toEqual({
      fetch: false,
      pull: false,
      push: false,
      publish: true,
    })
  })

  it('disables every action while busy, including Fetch', () => {
    const flags = Object.fromEntries(
      scmMoreMenuEntries({
        showOpenPullRequest: true,
        showSignIn: true,
        busy: true,
      })
        .filter((entry) => entry.kind === 'item')
        .map((entry) => [entry.id, entry.disabled]),
    )
    expect(flags).toEqual({
      fetch: true,
      pull: true,
      push: true,
      publish: true,
      openPullRequest: true,
      signIn: true,
    })
  })
})
