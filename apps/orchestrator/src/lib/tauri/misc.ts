import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import type { InstallToolchain } from '../agentInstall'
import type { WorktreeMode } from './git'

export async function loadProjectsFile(): Promise<string | null> {
  return invoke<string | null>('load_projects')
}

export async function saveProjectsFile(content: string, sequence: number): Promise<void> {
  await invoke('save_projects', { content, sequence })
}

                                                                                                     
export async function recordFrontendError(
  message: string,
  stack: string | null,
  kind: string,
): Promise<void> {
  try {
    await invoke('record_frontend_error', { message, stack, kind })
  } catch {
    /* logging best-effort */
  }
}

/** Records a non-sensitive lifecycle event for persistence diagnostics. */
export async function recordAppEvent(kind: string, message: string): Promise<void> {
  try {
    await invoke('record_app_event', { kind, message })
  } catch {
    /* logging best-effort */
  }
}

export async function findCliLauncher(agent: string): Promise<string | null> {
  return invoke<string | null>('find_cli_launcher', { agent })
}

/** WSL distros installed on this machine (Windows build only; empty elsewhere). */
export async function wslListDistros(): Promise<string[]> {
  return invoke<string[]>('wsl_list_distros')
}

export type AgentDetection = {
  /** CLI command name as asked (`claude`, `agy`, …). */
  agent: string
  installed: boolean
  path: string | null
  version: string | null
  /** Distro the CLI was probed in, when `cwd` is inside WSL. */
  wslDistro: string | null
}

/**
 * Which agent CLIs can run for `cwd`. A WSL project (Windows build) is probed
 * inside its distro; otherwise this is the regular launcher lookup.
 */
export async function detectAgentsForCwd(
  cwd: string | undefined,
  agents?: string[],
): Promise<AgentDetection[]> {
  return invoke<AgentDetection[]>('detect_agents_for_cwd', { cwd: cwd ?? null, agents: agents ?? null })
}

/** Drop the launcher cache and resolve again, including the user's login PATH. Post-install only. */
export async function refreshCliPath(command: string): Promise<string | null> {
  return invoke<string | null>('refresh_cli_path', { command })
}

export async function probeInstallToolchain(): Promise<InstallToolchain> {
  return invoke<InstallToolchain>('probe_install_toolchain')
}

export async function agentCliVersion(agent: string): Promise<string | null> {
  return invoke<string | null>('agent_cli_version', { agent })
}

// --- RFC-001 — Event Bus & Observabilidade ---

export type EventBusPayload = {
  event_type: string
  timestamp_ms: number
  correlation_id: string
  task_id: string | null
  agent_id: string | null
  data: Record<string, any>
}

export async function publishEvent(event: EventBusPayload): Promise<void> {
  await invoke('publish_event', { event })
}

export function listenEventBus(handler: (event: EventBusPayload) => void): Promise<UnlistenFn> {
  return listen<EventBusPayload>('flashwork://event-bus', (event) => handler(event.payload))
}

// --- RFC-008 & RFC-005 — Validation & GSD Watcher ---

export type ValidationResult = {
  success: boolean
  stage: string
  output: string
}

export async function runValidation(cwd: string, commands: string[]): Promise<ValidationResult> {
  return invoke<ValidationResult>('run_validation', { cwd, commands })
}

export async function startGsdWatcher(projectId: string, repoPath: string): Promise<void> {
  await invoke('start_gsd_watcher', { projectId, repoPath })
}

export async function stopGsdWatcher(projectId: string, repoPath: string): Promise<void> {
  await invoke('stop_gsd_watcher', { projectId, repoPath })
}

// --- RFC-002 — Scheduler ---

export type SchedulerTask = {
  id: string
  projectId: string
  title: string
  dependencies: string[]
  status: 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'blocked'
  assignedAgentId: string | null
  leaseResource: string | null
                                                                           
  worktreePath: string | null
  priority: number
}

export async function getSchedulerTasks(projectId: string): Promise<SchedulerTask[]> {
  return invoke<SchedulerTask[]>('get_scheduler_tasks', { projectId })
}

export async function triggerSchedulerTick(
  projectId: string,
  repoPath: string,
  worktreeMode?: WorktreeMode,
): Promise<void> {
  await invoke('trigger_scheduler_tick', { projectId, repoPath, worktreeMode })
}

export async function cancelTask(taskId: string): Promise<void> {
  await invoke('cancel_task', { taskId })
}

// --- RFC-005 — Auditoria GSD ---

export type PlanningCommit = {
  hash: string
  author: string
  timestampMs: number
  subject: string
  agentId: string | null
}

export async function planningAuditRecord(
  repoPath: string,
  agentId?: string,
  reason?: string,
  projectId?: string,
): Promise<PlanningCommit | null> {
  return invoke<PlanningCommit | null>('planning_audit_record', {
    repoPath,
    agentId,
    reason,
    projectId,
  })
}

export async function planningAuditHistory(
  repoPath: string,
  limit?: number,
): Promise<PlanningCommit[]> {
  return invoke<PlanningCommit[]>('planning_audit_history', { repoPath, limit })
}

export async function setPlanningAutocommit(enabled: boolean): Promise<void> {
  await invoke('set_planning_autocommit', { enabled })
}

export async function getPlanningAutocommit(): Promise<boolean> {
  return invoke<boolean>('get_planning_autocommit')
}
