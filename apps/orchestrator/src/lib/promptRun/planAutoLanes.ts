import { type AgentType, type PromptRunStepReason, type RoutedAgent } from '../types'
import { classifyTask, classifyTaskKinds, type TaskKind } from './classifyTask'
import { routedAgentLabel } from './routedAgent'
import { selectAgent, type SelectAgentInput } from './selectAgent'

export type SkillCatalogEntry = {
  name: string
  description: string
  agents: string[]
}

export type PlanAutoLanesInput = {
  prompt: string
  enabledAgents: AgentType[]
  installedAgents: AgentType[]
  claudeFiveHourUtilization: number | null
  codexRateLimited: boolean
  reviewAgentProvider?: AgentType
  conflictAgentProvider?: AgentType
  lastUsedAgent?: AgentType
  skills?: SkillCatalogEntry[]
  includeOrchestrator?: boolean
}

export type AutoLane = {
  agent: RoutedAgent
  role: 'orchestrator' | 'worker'
  taskKind: TaskKind
  reason: PromptRunStepReason
  skillNames: string[]
  slicePrompt: string
}

const MAX_WORKERS = 3
const ORCHESTRATOR_PREF: AgentType[] = ['freebuff', 'mimo', 'opencode']

const KIND_LABEL: Record<Exclude<TaskKind, 'unknown'>, string> = {
  implement: 'implementation',
  mechanical: 'tests and mechanical work',
  review: 'review',
  explore: 'exploration',
  ui: 'UI and visual work',
}

function availableAgents(input: PlanAutoLanesInput): AgentType[] {
  const enabled = new Set(input.enabledAgents)
  const installed = input.installedAgents.filter((agent) => agent !== 'shell')
  const intersected = installed.filter((agent) => enabled.has(agent))
  return intersected.length > 0 ? intersected : installed
}

function toSelectInput(input: PlanAutoLanesInput, override: Partial<SelectAgentInput> = {}): SelectAgentInput {
  return {
    prompt: input.prompt,
    enabledAgents: input.enabledAgents,
    installedAgents: input.installedAgents,
    claudeFiveHourUtilization: input.claudeFiveHourUtilization,
    codexRateLimited: input.codexRateLimited,
    reviewAgentProvider: input.reviewAgentProvider,
    conflictAgentProvider: input.conflictAgentProvider,
    lastUsedAgent: input.lastUsedAgent,
    ...override,
  }
}

function asInstalledAgent(value: string, installed: AgentType[]): AgentType | undefined {
  return installed.find((agent) => agent === value)
}

export function matchPromptSkills(
  prompt: string,
  skills: SkillCatalogEntry[] | undefined,
  installed: AgentType[],
): Array<{ name: string; agent: AgentType }> {
  if (!skills?.length) return []
  const haystack = prompt.toLowerCase()
  const matches: Array<{ name: string; agent: AgentType }> = []
  const seen = new Set<string>()
  for (const skill of skills) {
    const name = skill.name.trim()
    if (name.length < 3) continue
    if (!haystack.includes(name.toLowerCase())) continue
    const agent = skill.agents
      .map((candidate) => asInstalledAgent(candidate, installed))
      .find((candidate): candidate is AgentType => Boolean(candidate))
    if (!agent) continue
    const key = `${agent}:${name.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    matches.push({ name, agent })
  }
  return matches
}

function kindLabel(kind: TaskKind): string {
  return kind === 'unknown' ? 'remaining work' : KIND_LABEL[kind]
}

function workerSlice(prompt: string, lane: AutoLane, siblings: readonly AutoLane[]): string {
  const lines: string[] = []
  if (lane.taskKind === 'unknown' && siblings.length === 0) {
    lines.push('Do the user request below.')
  } else {
    lines.push(`You own only the ${kindLabel(lane.taskKind)} slice of this request.`)
  }
  if (siblings.length > 0) {
    lines.push('Sibling panes — do not redo their work:')
    for (const sibling of siblings) {
      const skills = sibling.skillNames.length ? ` skills: ${sibling.skillNames.join(', ')}` : ''
      lines.push(`- ${routedAgentLabel(sibling.agent)} owns ${kindLabel(sibling.taskKind)}${skills}`)
    }
  }
  if (lane.skillNames.length > 0) {
    lines.push(`Use these installed skills: ${lane.skillNames.join(', ')}.`)
  }
  lines.push('', prompt)
  return lines.join('\n')
}

function assignWorkerPrompts(prompt: string, workers: AutoLane[]): void {
  for (const lane of workers) {
    lane.slicePrompt = workerSlice(
      prompt,
      lane,
      workers.filter((candidate) => candidate !== lane),
    )
  }
}

function orchestratorSlice(prompt: string, workers: AutoLane[]): string {
  const roster = workers
    .map((lane) => {
      const skills = lane.skillNames.length ? ` skills: ${lane.skillNames.join(', ')}` : ''
      return `- ${routedAgentLabel(lane.agent)} (${lane.taskKind}${skills})`
    })
    .join('\n')
  return [
    'Coordinate the worker panes. Do not implement the whole request yourself.',
    'Workers:',
    roster,
    '',
    prompt,
  ].join('\n')
}

function pickAgentForKind(
  input: PlanAutoLanesInput,
  kind: TaskKind,
  used: Set<AgentType>,
): AgentChoiceLike | null {
  const leftover = availableAgents(input).filter((agent) => !used.has(agent))
  if (leftover.length === 0) return null
  const choice = selectAgent(
    toSelectInput(input, {
      forcedKind: kind,
      enabledAgents: leftover,
      installedAgents: leftover,
    }),
  )
  if (!choice) return null
  return { agent: choice.agent, reason: choice.reason, taskKind: choice.taskKind }
}

type AgentChoiceLike = {
  agent: AgentType
  reason: PromptRunStepReason
  taskKind: TaskKind
}

export function planAutoLanes(input: PlanAutoLanesInput): AutoLane[] {
  const installed = availableAgents(input)
  if (installed.length === 0) return []

  const workers: AutoLane[] = []
  const used = new Set<AgentType>()
  const kinds = classifyTaskKinds(input.prompt)
  const primaryKind = kinds[0] ?? classifyTask(input.prompt)

  for (const match of matchPromptSkills(input.prompt, input.skills, installed)) {
    if (workers.length >= MAX_WORKERS) break
    const existing = workers.find((lane) => lane.agent === match.agent)
    if (existing) {
      if (!existing.skillNames.includes(match.name)) existing.skillNames.push(match.name)
      continue
    }
    if (used.has(match.agent)) continue
    used.add(match.agent)
    workers.push({
      agent: match.agent,
      role: 'worker',
      taskKind: primaryKind,
      reason: 'skill',
      skillNames: [match.name],
      slicePrompt: '',
    })
  }

  if (kinds.length > 1 && installed.length > 1) {
    for (const kind of kinds) {
      if (workers.length >= MAX_WORKERS) break
      if (workers.some((lane) => lane.taskKind === kind)) continue
      const choice = pickAgentForKind(input, kind, used)
      if (!choice) continue
      used.add(choice.agent)
      workers.push({
        agent: choice.agent,
        role: 'worker',
        taskKind: kind,
        reason: choice.reason,
        skillNames: [],
        slicePrompt: '',
      })
    }
  }

  if (workers.length === 0) {
    const choice = selectAgent(toSelectInput(input))
    if (!choice) return []
    used.add(choice.agent)
    workers.push({
      agent: choice.agent,
      role: 'worker',
      taskKind: choice.taskKind,
      reason: choice.reason,
      skillNames: [],
      slicePrompt: '',
    })
  }

  const claudeWorkers = workers.filter((lane) => lane.agent === 'claude')
  if (claudeWorkers.length > 1) {
    const [primary] = claudeWorkers
    const rest = workers.filter((lane) => lane.agent !== 'claude')
    workers.length = 0
    workers.push(primary, ...rest)
  }

  assignWorkerPrompts(input.prompt, workers)

  if (workers.length === 1) return workers

  if (input.includeOrchestrator === false) return workers

  const orchAgent =
    ORCHESTRATOR_PREF.find((agent) => installed.includes(agent) && !used.has(agent)) ??
    ORCHESTRATOR_PREF.find((agent) => installed.includes(agent))
  if (!orchAgent) return workers

  const orchestrator: AutoLane = {
    agent: orchAgent,
    role: 'orchestrator',
    taskKind: 'unknown',
    reason: 'orchestrator',
    skillNames: [],
    slicePrompt: orchestratorSlice(input.prompt, workers),
  }
  return [orchestrator, ...workers]
}
