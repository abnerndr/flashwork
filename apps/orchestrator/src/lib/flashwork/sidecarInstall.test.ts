import { describe, expect, it } from 'vitest'

import type { InstallToolchain } from '../agentInstall'
import { SIDECAR_INSTALL_CATALOG, sidecarInstallMethods } from './sidecarInstall'

const BARE: InstallToolchain = {
  node: null,
  npm: false,
  winget: false,
  scoop: false,
  choco: false,
  bun: false,
  pnpm: false,
}

describe('sidecarInstallMethods', () => {
  it('installs 9router via npm when npm exists', () => {
    const methods = sidecarInstallMethods('9router', { ...BARE, npm: true })
    expect(methods[0]).toMatchObject({
      id: 'npm',
      command: 'npm install -g 9router',
      verifyCommand: '9router',
    })
  })

  it('hides npm when the machine has no npm', () => {
    expect(sidecarInstallMethods('9router', BARE)).toEqual([])
  })

  it('does not add 9router to AgentType', () => {
    expect(SIDECAR_INSTALL_CATALOG['9router'].docsUrl).toContain('9router')
  })
})
