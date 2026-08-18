import type {
  AgentInstallCatalogEntry,
  InstallMethod,
  InstallMethodId,
  InstallToolchain,
} from '../agentInstall'

export type SidecarId = '9router'

const METHOD_ORDER: InstallMethodId[] = ['native', 'npm', 'winget', 'scoop', 'choco']

export const SIDECAR_INSTALL_CATALOG: Record<SidecarId, AgentInstallCatalogEntry> = {
  '9router': {
    docsUrl: 'https://www.npmjs.com/package/9router',
    methods: [
      {
        id: 'npm',
        command: 'npm install -g 9router',
        requires: 'npm',
        verifyCommand: '9router',
      },
    ],
  },
}

/**
 * Methods that will actually work on this machine, best first. A method without
 * `requires` needs nothing beyond a shell, so it always qualifies.
 */
export function sidecarInstallMethods(
  sidecar: SidecarId,
  toolchain: InstallToolchain | null,
): InstallMethod[] {
  const entry = SIDECAR_INSTALL_CATALOG[sidecar]
  if (!entry) return []
  return entry.methods
    .filter((method) => {
      if (!method.requires) return true
      if (!toolchain) return false
      return Boolean(toolchain[method.requires])
    })
    .sort((a, b) => METHOD_ORDER.indexOf(a.id) - METHOD_ORDER.indexOf(b.id))
}
