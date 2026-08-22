import { classifyTaskKinds, type TaskKind } from '../promptRun/classifyTask'
import { planAutoLanes, type PlanAutoLanesInput } from '../promptRun/planAutoLanes'
import { selectAgent } from '../promptRun/selectAgent'
import type { AgentType, TaskSlicePlan } from '../types'
import { filesOverlap } from './schedule'

const KINDS = new Set<TaskKind>(['implement', 'review', 'mechanical', 'explore', 'ui', 'unknown'])

export function extractJsonObject(text: string): unknown | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown
  } catch {
    return null
  }
}

function asAgent(value: unknown, installed: AgentType[]): AgentType | undefined {
  if (typeof value !== 'string') return undefined
  return installed.find((agent) => agent === value)
}

function asKind(value: unknown): TaskKind {
  if (typeof value === 'string' && KINDS.has(value as TaskKind)) return value as TaskKind
  return 'unknown'
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

export type PlannerContext = PlanAutoLanesInput & {
  allowedFiles?: string[]
}

export function parsePlannerSlices(text: string, input: PlannerContext): TaskSlicePlan[] {
  const parsed = extractJsonObject(text)
  if (!parsed || typeof parsed !== 'object' || parsed === null) return []
  const rawSlices = (parsed as { slices?: unknown }).slices
  if (!Array.isArray(rawSlices) || rawSlices.length === 0) return []

  const slices: TaskSlicePlan[] = []
  const used = new Set<AgentType>()
  for (const [index, raw] of rawSlices.entries()) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    const kind = asKind(row.kind)
    let agent = asAgent(row.agent, input.installedAgents)
    if (!agent) {
      const leftover = input.installedAgents.filter((candidate) => !used.has(candidate) && candidate !== 'shell')
      const choice = selectAgent({
        ...input,
        enabledAgents: leftover.length > 0 ? leftover : input.enabledAgents,
        installedAgents: leftover.length > 0 ? leftover : input.installedAgents,
        forcedKind: kind === 'unknown' ? undefined : kind,
      })
      agent = choice?.agent
    }
    if (kind === 'ui') {
      const uiAgent = input.installedAgents.find((candidate) => candidate === 'antigravity')
      if (uiAgent) agent = uiAgent
    }
    if (!agent || agent === 'shell') continue
    used.add(agent)
    const id = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : `slice_${index + 1}`
    slices.push({
      id,
      kind,
      agent,
      prompt: typeof row.prompt === 'string' && row.prompt.trim() ? row.prompt.trim() : input.prompt,
      dependsOn: asStringArray(row.dependsOn),
      allowedFiles: asStringArray(row.allowedFiles).length
        ? asStringArray(row.allowedFiles)
        : [...(input.allowedFiles ?? [])],
      status: 'pending',
    })
  }
  return slices
}

export function serializeSiblingSlices(slices: TaskSlicePlan[]): TaskSlicePlan[] {
  if (slices.length < 2) return slices
  const next = slices.map((slice) => ({ ...slice, dependsOn: [...slice.dependsOn] }))
  const implementSlices = next.filter((slice) => slice.kind === 'implement')
  for (let index = 1; index < implementSlices.length; index += 1) {
    const previous = implementSlices[index - 1]
    const current = implementSlices[index]
    if (!previous || !current) continue
    if (!filesOverlap(previous.allowedFiles, current.allowedFiles)) continue
    if (!current.dependsOn.includes(previous.id)) {
      current.dependsOn = [...current.dependsOn, previous.id]
    }
  }
  const implementIds = implementSlices.map((slice) => slice.id)
  if (implementIds.length > 0) {
    for (const slice of next) {
      if (slice.kind === 'review' || slice.kind === 'mechanical') {
        slice.dependsOn = [...new Set([...slice.dependsOn, ...implementIds])]
      }
    }
  }
  return next
}

export function heuristicBoardSlices(input: PlannerContext): TaskSlicePlan[] {
  const lanes = planAutoLanes({ ...input, includeOrchestrator: false }).filter(
    (lane) => lane.role === 'worker',
  )
  const slices: TaskSlicePlan[] = lanes.map((lane, index) => ({
    id: `slice_${index + 1}`,
    kind: lane.taskKind,
    agent: lane.agent,
    prompt: lane.slicePrompt,
    dependsOn: [] as string[],
    allowedFiles: [...(input.allowedFiles ?? [])],
    status: 'pending' as const,
  }))
  if (slices.length === 0 && classifyTaskKinds(input.prompt).length === 0) {
    const fallback = planAutoLanes({ ...input, includeOrchestrator: false })[0]
    if (fallback) {
      return [
        {
          id: 'slice_1',
          kind: fallback.taskKind,
          agent: fallback.agent,
          prompt: fallback.slicePrompt,
          dependsOn: [],
          allowedFiles: [...(input.allowedFiles ?? [])],
          status: 'pending',
        },
      ]
    }
  }
  return serializeSiblingSlices(slices)
}

export function planBoardSlices(input: PlannerContext, plannerText?: string | null): TaskSlicePlan[] {
  if (plannerText) {
    const parsed = parsePlannerSlices(plannerText, input)
    if (parsed.length > 0) return serializeSiblingSlices(parsed)
  }
  return heuristicBoardSlices(input)
}

export function buildPlannerPrompt(input: {
  prompt: string
  allowedFiles: string[]
  installedAgents: AgentType[]
}): string {
  const files =
    input.allowedFiles.length > 0 ? input.allowedFiles.map((file) => `- ${file}`).join('\n') : '- (whole repo)'
  return [
    'You plan work for Flashwork. Return ONLY a JSON object, no markdown.',
    'Schema: {"slices":[{"id":"slice_1","kind":"implement|review|mechanical|explore|ui","agent":"<installed cli>","prompt":"...","allowedFiles":["relative/path"],"dependsOn":[]}]}',
    `Installed agents: ${input.installedAgents.filter((agent) => agent !== 'shell').join(', ')}`,
    'Use Claude and Gemini for heavy implementation. Include Codex when it is installed. Use Antigravity for UI. If only one CLI is installed, use that one.',
    'Allowed files:',
    files,
    'User request:',
    input.prompt,
  ].join('\n')
}
