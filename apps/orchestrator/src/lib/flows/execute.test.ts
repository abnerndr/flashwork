import { describe, expect, it } from 'vitest'

import { defaultHttpBody } from './httpUrl'

describe('defaultHttpBody', () => {
  it('sends previous output as { text } JSON by default', () => {
    expect(defaultHttpBody(undefined, 'hello')).toBe(JSON.stringify({ text: 'hello' }))
  })

  it('keeps an explicit body', () => {
    expect(defaultHttpBody('{"a":1}', 'hello')).toBe('{"a":1}')
  })
})
