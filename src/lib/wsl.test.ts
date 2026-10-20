import { describe, expect, it } from 'vitest'

import {
  folderForNewProject,
  linuxHomeProjectFolder,
  linuxPathToWslUnc,
  parseWslPath,
  preferredWslDistro,
  resolveProjectFolder,
  wslDistroFromPath,
} from './wsl'

describe('wsl paths', () => {
  it('parses every UNC spelling', () => {
    expect(parseWslPath('\\\\wsl$\\Ubuntu\\home\\u\\p')).toEqual({
      distro: 'Ubuntu',
      linuxPath: '/home/u/p',
    })
    expect(parseWslPath('\\\\wsl.localhost\\Debian\\srv\\')).toEqual({
      distro: 'Debian',
      linuxPath: '/srv',
    })
    expect(parseWslPath('\\\\?\\UNC\\wsl.localhost\\Arch\\a')).toEqual({
      distro: 'Arch',
      linuxPath: '/a',
    })
    expect(parseWslPath('//wsl.localhost/Ubuntu/home/u')).toEqual({
      distro: 'Ubuntu',
      linuxPath: '/home/u',
    })
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

  it('preserves slash-form UNC paths when a distribution is selected', () => {
    expect(resolveProjectFolder('//wsl.localhost/Ubuntu/home/u', 'Ubuntu')).toBe(
      '//wsl.localhost/Ubuntu/home/u',
    )
    expect(resolveProjectFolder('C:\\x', undefined)).toBe('C:\\x')
  })

  it('resolves the stored project folder', () => {
    expect(resolveProjectFolder(' /home/u/p ', 'Ubuntu')).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\u\\p',
    )
    expect(resolveProjectFolder('/home/u/p', undefined)).toBe('/home/u/p')
    expect(resolveProjectFolder('C:\\x', 'Ubuntu')).toBe('C:\\x')
  })

  it('prefers a running user distribution over docker-desktop', () => {
    expect(preferredWslDistro(['docker-desktop', 'Ubuntu-24.04'], ['Ubuntu-24.04'])).toBe(
      'Ubuntu-24.04',
    )
    expect(preferredWslDistro(['Ubuntu-24.04', 'Debian'], [], 'Debian')).toBe('Debian')
  })

  it('creates a Linux home folder when a WSL project has no path', () => {
    expect(linuxHomeProjectFolder('Meu Projeto')).toBe('~/meu-projeto')
    expect(folderForNewProject('', 'Ubuntu-24.04', 'Site')).toBe('~/site')
    expect(folderForNewProject('C:\\apps', 'Ubuntu-24.04', 'Site')).toBe('C:\\apps')
    expect(folderForNewProject('', undefined, 'Site')).toBe('')
  })
})
