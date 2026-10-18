import { invoke } from '@tauri-apps/api/core'

// --- RFC-004 — Graphify ---

export type GraphifyStatus = {
  available: boolean
  command: string
  version?: string
}

export type GraphNode = {
  id: string
  label: string
  kind?: string
  group?: string
}

export type GraphEdge = {
  id: string
  source: string
  target: string
  label?: string
}

export type GraphData = {
  nodes: GraphNode[]
  edges: GraphEdge[]
  nodeCount: number
  edgeCount: number
  truncated: boolean
}

export type GraphSnapshotInfo = {
  id: string
  path: string
  createdMs: number
  sizeBytes: number
}

/** `repo` routes the probe into the project's WSL distro when it lives in one. */
export async function graphifyDetect(command?: string, repo?: string): Promise<GraphifyStatus> {
  return invoke<GraphifyStatus>('graphify_detect', { command, repo })
}

export type GraphifyInstallStatus = {
  installed: boolean
  version?: string | null
  command?: string | null
  /** `graphify-mcp` entrypoint; absent when installed without the `[mcp]` extra. */
  mcpCommand?: string | null
  /** Installers found, in fallback order (`uv`, `pipx`, `pip`). */
  installers: string[]
  wslDistro?: string | null
}

export type GraphifyInstallResult = {
  ok: boolean
  installer?: string | null
  output: string
  status: GraphifyInstallStatus
}

export async function graphifyStatus(repo?: string): Promise<GraphifyInstallStatus> {
  return invoke<GraphifyInstallStatus>('graphify_status', { repo })
}

/** Installs `graphifyy[mcp]` via uv → pipx → pip (inside the WSL distro for WSL projects). */
export async function graphifyInstall(repo?: string): Promise<GraphifyInstallResult> {
  return invoke<GraphifyInstallResult>('graphify_install', { repo })
}

/**
 * Starts a background code-only build (`GRAPHIFY_BACKEND=none`) when `graphify-out/graph.json`
 * is missing. Never blocks on the build itself.
 */
export async function graphifyEnsureGraph(
  repo: string,
  command?: string,
): Promise<'exists' | 'generating' | 'started' | 'unavailable'> {
  return invoke<'exists' | 'generating' | 'started' | 'unavailable'>('graphify_ensure_graph', {
    repo,
    command,
  })
}

/**
 * MCP wiring: `repo` is where the agent CLI runs (configs are written there, may be a
 * worktree); `graphRepo` is the project folder whose graph is served (defaults to `repo`).
 * The writers are no-ops when Graphify is not installed.
 */
export async function graphifyMcpConfigPath(repo: string, graphRepo?: string): Promise<string> {
  return invoke<string>('graphify_mcp_config_path', { repo, graphRepo })
}

export async function graphifyOpenCodeConfigWrite(repo: string, graphRepo?: string): Promise<void> {
  await invoke('graphify_opencode_config_write', { repo, graphRepo })
}

export async function graphifyCodexConfigWrite(repo: string, graphRepo?: string): Promise<void> {
  await invoke('graphify_codex_config_write', { repo, graphRepo })
}

export async function graphifyGeminiConfigWrite(repo: string, graphRepo?: string): Promise<void> {
  await invoke('graphify_gemini_config_write', { repo, graphRepo })
}

export async function graphifyReadGraph(repo: string): Promise<GraphData> {
  return invoke<GraphData>('graphify_read_graph', { repo })
}

export async function graphifySnapshot(
  repo: string,
  projectId?: string,
): Promise<GraphSnapshotInfo> {
  return invoke<GraphSnapshotInfo>('graphify_snapshot', { repo, projectId })
}

export async function graphifyListSnapshots(repo: string): Promise<GraphSnapshotInfo[]> {
  return invoke<GraphSnapshotInfo[]>('graphify_list_snapshots', { repo })
}

export async function graphifyRollback(
  repo: string,
  snapshotId: string,
  projectId?: string,
): Promise<void> {
  await invoke('graphify_rollback', { repo, snapshotId, projectId })
}

export async function graphifyPruneSnapshots(
  repo: string,
  keepLast: number,
  maxAgeDays?: number,
  projectId?: string,
): Promise<void> {
  await invoke('graphify_prune_snapshots', { repo, keepLast, maxAgeDays, projectId })
}
