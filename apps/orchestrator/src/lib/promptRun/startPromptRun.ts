import { nanoid } from 'nanoid'

import {
  AGENT_TYPE_LABELS,
  UNRESTRICTED_FLAG,
  type AgentType,
  type PromptRun,
  type PromptRunStatus,
  type PromptRunStep,
} from '../types'
import { buildRunBootstrapInput } from './bootstrapPrompt'
import { isPromptRunBlocking } from './isPromptRunBlocking'
import { planAutoLanes, type AutoLane, type SkillCatalogEntry } from './planAutoLanes'

export type StartPromptRunResult =
  | { ok: true; run: PromptRun }
  | { ok: false; code: 'no-project' | 'no-cwd' | 'run-active' | 'needs-install' }

export type StartPromptRunProject = {
  id: string
  name: string
  reviewAgentProvider?: AgentType
  conflictAgentProvider?: AgentType
  lastUsedAgent?: AgentType
}

export type CreateAgentTerminal = (
  projectId: string,
  args: {
    name: string
    cwd: string
    firstTab: {
      type: AgentType
      cwd: string
      extraArgs?: string[]
      initialInput?: string
    }
  },
) => Promise<{ id: string }>

export type StartPromptRunInput = {
  project: StartPromptRunProject | null
  cwd: string
  prompt: string
  unrestricted: boolean
  enabledAgents: AgentType[]
  installedAgents: AgentType[]
  claudeFiveHourUtilization: number | null
  codexRateLimited: boolean
  activeRunStatus?: PromptRunStatus
  activeTerminalId?: string
  activeRunTerminalIds?: readonly string[]
  liveTerminalIds?: readonly string[]
  skills?: SkillCatalogEntry[]
  lanes?: AutoLane[]
  includeOrchestrator?: boolean
  allowedFiles?: string[]
  boardPath?: string
  createId?: () => string
  now?: () => number
  createAgentTerminal: CreateAgentTerminal
}

export type LaunchPromptRunLanesInput = {
  projectId: string
  cwd: string
  runId: string
  unrestricted: boolean
  lanes: AutoLane[]
  allowedFiles?: string[]
  boardPath?: string
  now?: () => number
  createAgentTerminal: CreateAgentTerminal
}

export async function launchPromptRunLanes(
  input: LaunchPromptRunLanesInput,
): Promise<PromptRunStep[]> {
  const createdAt = (input.now ?? Date.now)()
  const steps: PromptRunStep[] = []
  for (const lane of input.lanes) {
    const flag = input.unrestricted ? UNRESTRICTED_FLAG[lane.agent] : null
    const extraArgs = flag ? [flag] : undefined
    const paneName =
      lane.role === 'orchestrator'
        ? `Auto · ${AGENT_TYPE_LABELS[lane.agent]}`
        : AGENT_TYPE_LABELS[lane.agent]
    const terminal = await input.createAgentTerminal(input.projectId, {
      name: paneName,
      cwd: input.cwd,
      firstTab: {
        type: lane.agent,
        cwd: input.cwd,
        extraArgs,
        initialInput: buildRunBootstrapInput({
          runId: input.runId,
          prompt: lane.slicePrompt,
          agent: lane.agent,
          role: lane.role,
          skillNames: lane.skillNames,
          allowedFiles: input.allowedFiles,
          boardPath: input.boardPath,
        }),
      },
    })
    steps.push({
      agent: lane.agent,
      reason: lane.reason,
      startedAt: createdAt,
      terminalId: terminal.id,
    })
  }
  return steps
}

export async function startPromptRun(input: StartPromptRunInput): Promise<StartPromptRunResult> {
  if (!input.project) return { ok: false, code: 'no-project' }
  if (!input.cwd.trim()) return { ok: false, code: 'no-cwd' }
  const runTerminalIds = [
    ...(input.activeRunTerminalIds ?? []),
    ...(input.activeTerminalId ? [input.activeTerminalId] : []),
  ]
  if (isPromptRunBlocking(input.activeRunStatus, runTerminalIds, input.liveTerminalIds)) {
    return { ok: false, code: 'run-active' }
  }

  const lanes = (
    input.lanes ??
    planAutoLanes({
      prompt: input.prompt,
      enabledAgents: input.enabledAgents,
      installedAgents: input.installedAgents,
      claudeFiveHourUtilization: input.claudeFiveHourUtilization,
      codexRateLimited: input.codexRateLimited,
      reviewAgentProvider: input.project.reviewAgentProvider,
      conflictAgentProvider: input.project.conflictAgentProvider,
      lastUsedAgent: input.project.lastUsedAgent,
      skills: input.skills,
      includeOrchestrator: input.includeOrchestrator,
    })
  ).filter((lane) => input.includeOrchestrator !== false || lane.role !== 'orchestrator')
  if (lanes.length === 0) return { ok: false, code: 'needs-install' }

  const createId = input.createId ?? nanoid
  const now = input.now ?? Date.now
  const runId = createId()
  const createdAt = now()
  const journalPath = `runs/${runId}/journal.md`
  const cwd = input.cwd.trim()
  const steps = await launchPromptRunLanes({
    projectId: input.project.id,
    cwd,
    runId,
    unrestricted: input.unrestricted,
    lanes,
    allowedFiles: input.allowedFiles,
    boardPath: input.boardPath,
    now,
    createAgentTerminal: input.createAgentTerminal,
  })
  const run: PromptRun = {
    id: runId,
    projectId: input.project.id,
    cwd,
    prompt: input.prompt,
    status: 'running',
    activeAgent: lanes[0].agent,
    activeTerminalId: steps[0]?.terminalId ?? '',
    unrestricted: input.unrestricted,
    steps,
    journalPath,
    createdAt,
  }

  return { ok: true, run }
}
