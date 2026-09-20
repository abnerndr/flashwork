import { describe, expect, it } from 'vitest'

import { assertFlowHttpUrl, flowHttpHosts } from './httpUrl'

const confirmed = {
  allowLoopback: false,
  allowlistHosts: [],
  confirmedHosts: ['example.com'],
}

describe('assertFlowHttpUrl', () => {
  it('denies file, javascript, and other non-http schemes', () => {
    expect(() => assertFlowHttpUrl('file:///etc/passwd', confirmed)).toThrow(/url_scheme/)
    expect(() => assertFlowHttpUrl('javascript:alert(1)', confirmed)).toThrow(/url_scheme/)
    expect(() => assertFlowHttpUrl('data:text/plain,hi', confirmed)).toThrow(/url_scheme/)
    expect(() => assertFlowHttpUrl('ftp://example.com/a', confirmed)).toThrow(/url_scheme/)
  })

  it('allows https after the per-run confirm list', () => {
    expect(assertFlowHttpUrl('https://example.com/v1', confirmed).hostname).toBe('example.com')
    expect(() =>
      assertFlowHttpUrl('https://other.test/v1', confirmed),
    ).toThrow(/url_unconfirmed/)
  })

  it('allows loopback http only when the preference is on', () => {
    expect(() =>
      assertFlowHttpUrl('http://127.0.0.1:8787/hook', {
        ...confirmed,
        confirmedHosts: ['127.0.0.1'],
      }),
    ).toThrow(/url_loopback_denied/)
    expect(
      assertFlowHttpUrl('http://127.0.0.1:8787/hook', {
        allowLoopback: true,
        allowlistHosts: [],
        confirmedHosts: ['127.0.0.1'],
      }).host,
    ).toBe('127.0.0.1:8787')
  })

  it('denies other http hosts until they are allowlisted and confirmed', () => {
    expect(() =>
      assertFlowHttpUrl('http://api.internal/v1', {
        allowLoopback: false,
        allowlistHosts: [],
        confirmedHosts: ['api.internal'],
      }),
    ).toThrow(/url_not_allowlisted/)
    expect(
      assertFlowHttpUrl('http://api.internal/v1', {
        allowLoopback: false,
        allowlistHosts: ['api.internal'],
        confirmedHosts: ['api.internal'],
      }).hostname,
    ).toBe('api.internal')
  })
})

describe('flowHttpHosts', () => {
  it('collects unique hostnames', () => {
    expect(
      flowHttpHosts(['https://a.test/x', 'https://A.test/y', 'https://b.test/', 'not-a-url']),
    ).toEqual(['a.test', 'b.test'])
  })
})
