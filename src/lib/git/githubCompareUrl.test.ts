import { describe, expect, it } from 'vitest'

import { githubCompareUrl } from './githubCompareUrl'

describe('githubCompareUrl', () => {
  it('builds the GitHub compare URL for an HTTPS origin', () => {
    expect(githubCompareUrl('https://github.com/acme/app.git', 'feat/x')).toBe(
      'https://github.com/acme/app/compare/feat/x?expand=1',
    )
  })

  it('parses SSH remotes into the same HTTPS compare URL', () => {
    expect(githubCompareUrl('git@github.com:acme/app.git', 'feat/x')).toBe(
      'https://github.com/acme/app/compare/feat/x?expand=1',
    )
    expect(githubCompareUrl('ssh://git@github.com/acme/app.git', 'feat/x')).toBe(
      'https://github.com/acme/app/compare/feat/x?expand=1',
    )
  })

  it('encodes branch path segments while keeping slashes', () => {
    expect(githubCompareUrl('https://github.com/acme/app.git', 'feat/foo bar')).toBe(
      'https://github.com/acme/app/compare/feat/foo%20bar?expand=1',
    )
  })

  it('returns null when origin is not github.com', () => {
    expect(githubCompareUrl('https://gitlab.com/acme/app.git', 'feat/x')).toBeNull()
    expect(githubCompareUrl('https://github.com/acme/app.git', '')).toBeNull()
  })
})
