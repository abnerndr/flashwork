export type GraphifyEnsureStatus = 'exists' | 'generating' | 'started' | 'unavailable'

export type RagGraphifyStatus = 'exists' | 'unavailable'

export type RagStatusJson = {
  graphify: RagGraphifyStatus
  updatedAt: string
}

export function mapGraphifyBootstrapStatus(
  status: GraphifyEnsureStatus | undefined,
): RagGraphifyStatus {
  if (status === 'exists' || status === 'generating' || status === 'started') {
    return 'exists'
  }
  return 'unavailable'
}

export async function bootstrapProjectRag(
  folder: string,
  dependencies: {
    graphifyEnsureGraph: (repo: string) => Promise<GraphifyEnsureStatus>
    /** Graphify is not installed for this folder (host or WSL distro): offer the install. */
    onGraphifyUnavailable?: (folder: string) => void
    writeRagStatus: (folder: string, status: RagStatusJson) => Promise<unknown>
    now?: () => string
  },
): Promise<RagStatusJson> {
  // Every project folder gets Graphify: a code-only build starts in the background.
  let ensured: GraphifyEnsureStatus | undefined
  try {
    ensured = await dependencies.graphifyEnsureGraph(folder)
  } catch {
    ensured = undefined
  }
  const graphify = mapGraphifyBootstrapStatus(ensured)
  if (ensured === 'unavailable') dependencies.onGraphifyUnavailable?.(folder)

  const status: RagStatusJson = {
    graphify,
    updatedAt: dependencies.now?.() ?? new Date().toISOString(),
  }

  try {
    await dependencies.writeRagStatus(folder, status)
  } catch {
    // STATUS.json is a follow-up signal; never fail project creation.
  }

  return status
}
