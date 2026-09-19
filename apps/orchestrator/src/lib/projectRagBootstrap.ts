export type GraphifyEnsureStatus = 'exists' | 'generating' | 'started' | 'unavailable'

export type RagGraphifyStatus = 'exists' | 'unavailable'

export type RagStatusJson = {
  graphify: RagGraphifyStatus
  aiMemory: boolean
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
    graphifyEnabled: boolean
    aiMemoryEnabled: boolean
    graphifyEnsureGraph: (repo: string) => Promise<GraphifyEnsureStatus>
    aiMemoryMcpConfigPath: (repo: string) => Promise<string>
    writeRagStatus: (folder: string, status: RagStatusJson) => Promise<unknown>
    now?: () => string
  },
): Promise<RagStatusJson> {
  let graphify: RagGraphifyStatus = 'unavailable'
  if (dependencies.graphifyEnabled) {
    try {
      graphify = mapGraphifyBootstrapStatus(await dependencies.graphifyEnsureGraph(folder))
    } catch {
      graphify = 'unavailable'
    }
  }

  let aiMemory = false
  if (dependencies.aiMemoryEnabled) {
    try {
      await dependencies.aiMemoryMcpConfigPath(folder)
      aiMemory = true
    } catch {
      aiMemory = false
    }
  }

  const status: RagStatusJson = {
    graphify,
    aiMemory,
    updatedAt: dependencies.now?.() ?? new Date().toISOString(),
  }

  try {
    await dependencies.writeRagStatus(folder, status)
  } catch {
    // STATUS.json is a follow-up signal; never fail project creation.
  }

  return status
}
