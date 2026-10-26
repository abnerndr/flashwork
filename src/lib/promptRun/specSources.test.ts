import { describe, expect, it } from 'vitest'

import { joinSpecSources } from './specSources'

describe('joinSpecSources', () => {
  it('keeps each markdown file as its own section and appends typed text', () => {
    const spec = joinSpecSources('Ship the login form.', [
      { name: 'api.md', content: 'Add the API.' },
      { name: 'web.md', content: '  Add the page.  ' },
    ])
    expect(spec).toContain('## SPEC file: api.md\n\nAdd the API.')
    expect(spec).toContain('## SPEC file: web.md\n\nAdd the page.')
    expect(spec).toContain('## Typed SPEC\n\nShip the login form.')
    expect(spec.indexOf('api.md')).toBeLessThan(spec.indexOf('web.md'))
    expect(spec.indexOf('web.md')).toBeLessThan(spec.indexOf('Typed SPEC'))
  })

  it('returns only the typed text when nothing is attached', () => {
    expect(joinSpecSources('  Just this.  ', [])).toBe('Just this.')
  })
})
