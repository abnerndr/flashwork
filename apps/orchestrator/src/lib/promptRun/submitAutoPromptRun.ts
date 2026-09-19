import { getCachedClaudeUsage } from '../claudeUsageCache'
import { getCachedCodexUsage } from '../codexUsageCache'
import { groupSkillsByName } from '../skills'
import { ALL_AGENT_TYPES, type AgentType } from '../types'
import { appendPromptRunJournal, ensurePromptRunContext, skillsScan } from '../tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import { usePromptRunStore } from '../../stores/promptRunStore'
import { excludeFailedAgents } from './failedAgents'
import { freeProbe, productionFreeProbeDeps } from './freeRouter'
import { probeInstalledAgents } from './probeInstalled'
import { type AutoLane } from './planAutoLanes'
import { routeOpenTask } from './routeTask'
import { startPromptRun, type StartPromptRunResult } from './startPromptRun'
import { providerChat, providerKeyStatus } from '../tauri/providers'
import { pickEffectiveCodingModel } from '../providers/catalogOverlay'

export type AutoPromptRunProject = {
  id: string
  name: string
  reviewAgentProvider?: AgentType
  conflictAgentProvider?: AgentType
  lastUsedAgent?: AgentType
  terminals: Array<{ id: string }>
}

export function toAutoPromptRunProject(
  project: {
    id: string
    name: string
    reviewAgentProvider?: AgentType
    conflictAgentProvider?: AgentType
    terminals: Array<{ id: string; tabs: Array<{ type: AgentType }> }>
  } | null,
): AutoPromptRunProject | null {
  if (!project) return null
  return {
    id: project.id,
    name: project.name,
    reviewAgentProvider: project.reviewAgentProvider,
    conflictAgentProvider: project.conflictAgentProvider,
    lastUsedAgent: project.terminals[project.terminals.length - 1]?.tabs[0]?.type,
    terminals: project.terminals,
  }
}

export function lanesFromRoutedChoice(
  routed: Pick<AutoLane, 'agent' | 'taskKind' | 'reason'>,
  prompt: string,
): AutoLane[] {
  return [
    {
      agent: routed.agent,
      role: 'worker',
      taskKind: routed.taskKind,
      reason: routed.reason,
      skillNames: [],
      slicePrompt: prompt,
    },
  ]
}

export async function submitAutoPromptRun(args: {
  project: AutoPromptRunProject | null
  cwd: string
  prompt: string
  unrestricted: boolean
}): Promise<StartPromptRunResult> {
  const preferences = useProjectsStore.getState().preferences
  const existing = args.project
    ? usePromptRunStore.getState().byProjectId[args.project.id]
    : undefined
  const installed = excludeFailedAgents(
    await probeInstalledAgents(
      ALL_AGENT_TYPES.filter((agent) => preferences.enabledAgents[agent] && agent !== 'shell'),
    ),
  )
  const [claudeUsage, codexUsage, skillSnapshots] = await Promise.all([
    getCachedClaudeUsage().catch(() => null),
    getCachedCodexUsage().catch(() => null),
    skillsScan().catch(() => []),
  ])
  const skills = groupSkillsByName(skillSnapshots).map((group) => ({
    name: group.name,
    description: group.description,
    agents: group.agents,
  }))
  const enabledAgents = ALL_AGENT_TYPES.filter((agent) => preferences.enabledAgents[agent])
  const selectInput = {
    prompt: args.prompt,
    enabledAgents,
    installedAgents: installed,
    claudeFiveHourUtilization: claudeUsage?.five_hour.utilization ?? null,
    codexRateLimited: Boolean(codexUsage?.rate_limited),
    reviewAgentProvider: args.project?.reviewAgentProvider,
    conflictAgentProvider: args.project?.conflictAgentProvider,
    lastUsedAgent: args.project?.lastUsedAgent,
  }
  const probe = () =>
    freeProbe({ prompt: args.prompt, installedAgents: installed }, productionFreeProbeDeps())
  const routed = await routeOpenTask({
    ...selectInput,
    probe,
    keyStatus: providerKeyStatus,
  })
  if (!routed.ok) {
    return { ok: false, code: routed.needsSetup === 'api' ? 'needs-setup-api' : 'needs-install' }
  }
  const result = await startPromptRun({
    project: args.project
      ? {
          id: args.project.id,
          name: args.project.name,
          reviewAgentProvider: args.project.reviewAgentProvider,
          conflictAgentProvider: args.project.conflictAgentProvider,
          lastUsedAgent: args.project.lastUsedAgent,
        }
      : null,
    cwd: args.cwd,
    prompt: args.prompt,
    unrestricted: args.unrestricted,
    enabledAgents,
    installedAgents: installed,
    claudeFiveHourUtilization: selectInput.claudeFiveHourUtilization,
    codexRateLimited: selectInput.codexRateLimited,
    activeRunStatus: existing?.status,
    activeTerminalId: existing?.activeTerminalId,
    activeRunTerminalIds: existing?.steps
      .map((step) => step.terminalId)
      .filter((id): id is string => Boolean(id)),
    liveTerminalIds: args.project?.terminals.map((terminal) => terminal.id) ?? [],
    skills,
    lanes: lanesFromRoutedChoice(routed, args.prompt),
    includeOrchestrator: false,
    ensureContextDir: ensurePromptRunContext,
    createAgentTerminal: (projectId, launch) =>
      useProjectsStore.getState().createAgentTerminal(projectId, launch),
    chat: providerChat,
    pickCodingModel: pickEffectiveCodingModel,
  })
  if (!result.ok) return result
  usePromptRunStore.getState().setRun(result.run)
  try {
    const journalPath = await appendPromptRunJournal(result.run.id, 'Run started', args.prompt)
    usePromptRunStore.getState().patchRun(result.run.projectId, { journalPath })
  } catch (cause) {
    console.warn('[prompt-run] journal append failed:', cause)
  }
  return result
}
