import { nanoid } from 'nanoid'

import {
  AGENT_TYPE_LABELS,
  UNRESTRICTED_FLAG,
  type AgentType,
  type PromptRun,
  type PromptRunStatus,
} from '../types'
import { buildRunBootstrapInput } from './bootstrapPrompt'
import { selectAgent } from './selectAgent'

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
  createId?: () => string
  now?: () => number
  createAgentTerminal: CreateAgentTerminal
}

export async function startPromptRun(input: StartPromptRunInput): Promise<StartPromptRunResult> {
  if (!input.project) return { ok: false, code: 'no-project' }
  if (!input.cwd.trim()) return { ok: false, code: 'no-cwd' }
  if (input.activeRunStatus === 'running' || input.activeRunStatus === 'handing-off') {
    return { ok: false, code: 'run-active' }
  }

  const choice = selectAgent({
    prompt: input.prompt,
    enabledAgents: input.enabledAgents,
    installedAgents: input.installedAgents,
    claudeFiveHourUtilization: input.claudeFiveHourUtilization,
    codexRateLimited: input.codexRateLimited,
    reviewAgentProvider: input.project.reviewAgentProvider,
    conflictAgentProvider: input.project.conflictAgentProvider,
    lastUsedAgent: input.project.lastUsedAgent,
  })
  if (!choice) return { ok: false, code: 'needs-install' }

  const createId = input.createId ?? nanoid
  const now = input.now ?? Date.now
  const runId = createId()
  const createdAt = now()
  const journalPath = `runs/${runId}/journal.md`
  const cwd = input.cwd.trim()
  const flag = input.unrestricted ? UNRESTRICTED_FLAG[choice.agent] : null
  const extraArgs = flag ? [flag] : undefined

  const terminal = await input.createAgentTerminal(input.project.id, {
    name: AGENT_TYPE_LABELS[choice.agent],
    cwd,
    firstTab: {
      type: choice.agent,
      cwd,
      extraArgs,
      initialInput: buildRunBootstrapInput({
        runId,
        prompt: input.prompt,
        agent: choice.agent,
      }),
    },
  })

  const run: PromptRun = {
    id: runId,
    projectId: input.project.id,
    cwd,
    prompt: input.prompt,
    status: 'running',
    activeAgent: choice.agent,
    activeTerminalId: terminal.id,
    unrestricted: input.unrestricted,
    steps: [
      {
        agent: choice.agent,
        reason: choice.reason,
        startedAt: createdAt,
        terminalId: terminal.id,
      },
    ],
    journalPath,
    createdAt,
  }

  return { ok: true, run }
}
