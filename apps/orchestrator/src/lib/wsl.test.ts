import { describe, expect, it } from 'vitest'

import { linuxPathToWslUnc, parseWslPath, resolveProjectFolder, wslDistroFromPath } from './wsl'

describe('wsl paths', () => {
  it('parses every UNC spelling', () => {
    expect(parseWslPath('\\\\wsl$\\Ubuntu\\home\\u\\p')).toEqual({ distro: 'Ubuntu', linuxPath: '/home/u/p' })
    expect(parseWslPath('\\\\wsl.localhost\\Debian\\srv\\')).toEqual({ distro: 'Debian', linuxPath: '/srv' })
    expect(parseWslPath('\\\\?\\UNC\\wsl.localhost\\Arch\\a')).toEqual({ distro: 'Arch', linuxPath: '/a' })
    expect(parseWslPath('//wsl.localhost/Ubuntu/home/u')).toEqual({ distro: 'Ubuntu', linuxPath: '/home/u' })
    expect(parseWslPath('\\\\WSL$\\Ubuntu')).toEqual({ distro: 'Ubuntu', linuxPath: '/' })
  })

  it('rejects non-WSL paths', () => {
    expect(parseWslPath('C:\\Users\\u')).toBeNull()
    expect(parseWslPath('\\\\server\\share\\x')).toBeNull()
    expect(parseWslPath('/home/u')).toBeNull()
    expect(wslDistroFromPath(undefined)).toBeUndefined()
  })

  it('maps Linux paths to UNC and back', () => {
    const unc = linuxPathToWslUnc('Ubuntu', '/home/u/proj/')
    expect(unc).toBe('\\\\wsl.localhost\\Ubuntu\\home\\u\\proj')
    expect(parseWslPath(unc)).toEqual({ distro: 'Ubuntu', linuxPath: '/home/u/proj' })
  })

  it('resolves the stored project folder', () => {
    expect(resolveProjectFolder(' /home/u/p ', 'Ubuntu')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\u\\p')
    expect(resolveProjectFolder('/home/u/p', undefined)).toBe('/home/u/p')
    expect(resolveProjectFolder('C:\\x', 'Ubuntu')).toBe('C:\\x')
  })
})
