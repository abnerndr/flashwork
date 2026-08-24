import { getCachedClaudeUsage } from '../claudeUsageCache'
import { getCachedCodexUsage } from '../codexUsageCache'
import { groupSkillsByName } from '../skills'
import { ALL_AGENT_TYPES, type AgentType } from '../types'
import { appendPromptRunJournal, ensurePromptRunContext, skillsScan } from '../tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import { usePromptRunStore } from '../../stores/promptRunStore'
import { excludeFailedAgents } from './failedAgents'
import { probeInstalledAgents } from './probeInstalled'
import { startPromptRun, type StartPromptRunResult } from './startPromptRun'

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
    enabledAgents: ALL_AGENT_TYPES.filter((agent) => preferences.enabledAgents[agent]),
    installedAgents: installed,
    claudeFiveHourUtilization: claudeUsage?.five_hour.utilization ?? null,
    codexRateLimited: Boolean(codexUsage?.rate_limited),
    activeRunStatus: existing?.status,
    activeTerminalId: existing?.activeTerminalId,
    activeRunTerminalIds: existing?.steps
      .map((step) => step.terminalId)
      .filter((id): id is string => Boolean(id)),
    liveTerminalIds: args.project?.terminals.map((terminal) => terminal.id) ?? [],
    skills,
    includeOrchestrator: false,
    ensureContextDir: ensurePromptRunContext,
    createAgentTerminal: (projectId, launch) =>
      useProjectsStore.getState().createAgentTerminal(projectId, launch),
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
