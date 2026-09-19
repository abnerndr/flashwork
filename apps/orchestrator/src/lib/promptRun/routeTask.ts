import type { ProviderId } from '../providers/modelCatalog'
import type { AgentType, PromptRunStepReason, RoutedAgent } from '../types'
import { classifyTask, type TaskKind } from './classifyTask'
import { firstSavedProvider, hasCodingCli, isApiAgentId } from './routedAgent'
import { selectAgent, type SelectAgentInput } from './selectAgent'

export const ROUTE_TASK_PROBE_TIMEOUT_MS = 2500

export type RouteTaskInput = SelectAgentInput & {
  probe: () => Promise<unknown>
}

export type RoutedChoice = {
  agent: RoutedAgent
  reason: PromptRunStepReason
  taskKind: TaskKind
}

export type RouteOpenResult =
  | { ok: true; agent: RoutedAgent; taskKind: TaskKind; reason: PromptRunStepReason }
  | { ok: false; needsSetup: 'cli' | 'api' }

export type RouteOpenTaskInput = SelectAgentInput & {
  probe?: () => Promise<unknown>
  keyStatus?: (id: ProviderId) => Promise<{ saved: boolean }>
}

const TASK_KINDS: ReadonlySet<TaskKind> = new Set([
  'implement',
  'review',
  'mechanical',
  'explore',
  'ui',
  'unknown',
])

function isTaskKind(value: unknown): value is TaskKind {
  return typeof value === 'string' && TASK_KINDS.has(value as TaskKind)
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('probe timeout')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function parseProbe(payload: unknown): { kind: TaskKind; agent: string } | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  if (!isTaskKind(record.kind)) return null
  if (typeof record.agent !== 'string') return null
  return { kind: record.kind, agent: record.agent }
}

function isUsableProbeAgent(agent: string, installedAgents: AgentType[]): agent is RoutedAgent {
  if (isApiAgentId(agent)) return true
  return agent !== 'shell' && installedAgents.includes(agent as AgentType)
}

export async function routeTask(input: RouteTaskInput): Promise<RoutedChoice | null> {
  const { probe, ...selectInput } = input

  let parsed: { kind: TaskKind; agent: string } | null = null
  try {
    parsed = parseProbe(await withTimeout(Promise.resolve(probe()), ROUTE_TASK_PROBE_TIMEOUT_MS))
  } catch {
    parsed = null
  }

  if (!parsed) {
    return selectAgent(selectInput)
  }

  if (isUsableProbeAgent(parsed.agent, selectInput.installedAgents)) {
    return { agent: parsed.agent, taskKind: parsed.kind, reason: 'heuristic' }
  }

  return selectAgent({
    ...selectInput,
    forcedKind: parsed.kind !== 'unknown' ? parsed.kind : undefined,
  })
}

export async function routeOpenTask(input: RouteOpenTaskInput): Promise<RouteOpenResult> {
  const probe = input.probe ?? (async () => null)
  const { keyStatus, probe: _probe, ...selectInput } = input
  const routed = await routeTask({ ...selectInput, probe })
  if (routed) {
    return {
      ok: true,
      agent: routed.agent,
      taskKind: routed.taskKind,
      reason: routed.reason,
    }
  }

  const saved = keyStatus ? await firstSavedProvider(keyStatus) : null
  const hasCli = hasCodingCli(selectInput.installedAgents)
  if (!hasCli && !saved) return { ok: false, needsSetup: 'cli' }
  if (!hasCli && saved) {
    return {
      ok: true,
      agent: `api:${saved}`,
      taskKind: classifyTask(selectInput.prompt),
      reason: 'heuristic',
    }
  }
  if (!hasCli) return { ok: false, needsSetup: 'api' }
  return { ok: false, needsSetup: 'cli' }
}
