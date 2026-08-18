import { QUOTA_HANDOFF_THRESHOLD } from './constants'
import { classifyTask, type TaskKind } from './classifyTask'
import type { AgentType, PromptRunStepReason } from '../types'

export type SelectAgentInput = {
  prompt: string
  enabledAgents: AgentType[]
  installedAgents: AgentType[]
  claudeFiveHourUtilization: number | null
  codexRateLimited: boolean
  reviewAgentProvider?: AgentType
  conflictAgentProvider?: AgentType
  lastUsedAgent?: AgentType
}

export type AgentChoice = {
  agent: AgentType
  reason: PromptRunStepReason
  taskKind: TaskKind
}

const IMPLEMENT_PREF: AgentType[] = ['claude', 'codex', 'opencode']
const MECHANICAL_PREF: AgentType[] = ['codex', 'opencode', 'claude']
const EXPLORE_PREF: AgentType[] = ['claude', 'codex', 'opencode']

function usable(input: SelectAgentInput): AgentType[] {
  const enabled = new Set(input.enabledAgents)
  const installed = input.installedAgents.filter((agent) => agent !== 'shell')
  const intersected = installed.filter((agent) => enabled.has(agent))
  // Misconfigured enabled list must not strand Auto: fall back to installed CLIs.
  return intersected.length > 0 ? intersected : installed
}

function firstAvailable(order: AgentType[], available: AgentType[]): AgentType | undefined {
  return order.find((agent) => available.includes(agent)) ?? available[0]
}

function dropIfOthersRemain(pool: AgentType[], agent: AgentType): AgentType[] {
  const next = pool.filter((candidate) => candidate !== agent)
  return next.length > 0 ? next : pool
}

function applyQuotaFilters(available: AgentType[], input: SelectAgentInput): AgentType[] {
  let pool = available
  const claudeBlocked =
    pool.includes('claude') &&
    input.claudeFiveHourUtilization != null &&
    input.claudeFiveHourUtilization >= QUOTA_HANDOFF_THRESHOLD
  if (claudeBlocked) pool = dropIfOthersRemain(pool, 'claude')
  if (input.codexRateLimited) pool = dropIfOthersRemain(pool, 'codex')
  return pool
}

export function selectAgent(input: SelectAgentInput): AgentChoice | null {
  const available = usable(input)
  if (available.length === 0) return null
  const taskKind = classifyTask(input.prompt)

  if (available.length === 1) {
    return { agent: available[0], reason: 'only-installed', taskKind }
  }

  if (taskKind === 'review' && input.reviewAgentProvider && available.includes(input.reviewAgentProvider)) {
    return { agent: input.reviewAgentProvider, reason: 'project-preference', taskKind }
  }

  const pool = applyQuotaFilters(available, input)
  const quotaReduced = pool.length < available.length

  const order =
    taskKind === 'mechanical'
      ? MECHANICAL_PREF
      : taskKind === 'explore'
        ? EXPLORE_PREF
        : taskKind === 'implement'
          ? IMPLEMENT_PREF
          : null

  if (order) {
    const agent = firstAvailable(order, pool)
    if (agent) return { agent, reason: quotaReduced ? 'quota' : 'heuristic', taskKind }
  }

  if (input.lastUsedAgent && pool.includes(input.lastUsedAgent)) {
    return { agent: input.lastUsedAgent, reason: 'last-used', taskKind }
  }

  if (input.conflictAgentProvider && pool.includes(input.conflictAgentProvider)) {
    return { agent: input.conflictAgentProvider, reason: 'project-preference', taskKind }
  }

  return { agent: pool[0], reason: quotaReduced ? 'quota' : 'heuristic', taskKind }
}
