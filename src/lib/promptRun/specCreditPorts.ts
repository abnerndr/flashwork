import { AGENT_TYPE_LABELS, type AgentType } from '../types'
import { translate, getLocale } from '../i18n'
import { appendProjectRunBoard, appendPromptRunJournal } from '../tauri'
import { writePty } from '../tauri/pty'
import { useProjectsStore } from '../../stores/projectsStore'
import { usePromptRunStore } from '../../stores/promptRunStore'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { useUiStore } from '../../stores/uiStore'
import { launchPromptRunLanes } from './startPromptRun'
import { continueSpecRun, finishSpecRunIfSettled } from './runSpec'
import type { SpecCreditPorts } from './specCreditActions'

export function lanePtyStatus(projectId: string, terminalId: string): 'working' | 'waiting' | 'stopped' | 'disabled' | 'offline' | 'unknown' {
  const project = useProjectsStore.getState().projects.find((item) => item.id === projectId)
  const terminal = project?.terminals.find((item) => item.id === terminalId)
  const tab = terminal?.tabs.find((item) => item.id === terminal.activeTabId) ?? terminal?.tabs[0]
  if (!tab?.ptyId) return 'unknown'
  return useTerminalsStore.getState().byPtyId[tab.ptyId]?.status ?? 'unknown'
}

export function ptyIdForTerminal(projectId: string, terminalId: string): string | null {
  const project = useProjectsStore.getState().projects.find((item) => item.id === projectId)
  const terminal = project?.terminals.find((item) => item.id === terminalId)
  const tab = terminal?.tabs.find((item) => item.id === terminal.activeTabId) ?? terminal?.tabs[0]
  return tab?.ptyId ?? null
}

export function liveSpecCreditPorts(sourceAgent: AgentType): SpecCreditPorts {
  const locale = getLocale()
  const label = AGENT_TYPE_LABELS[sourceAgent]
  return {
    now: () => Date.now(),
    appendBoard: appendProjectRunBoard,
    appendJournal: appendPromptRunJournal,
    deleteTerminal: (projectId, terminalId) => useProjectsStore.getState().deleteTerminal(projectId, terminalId),
    patchRun: (projectId, patch) => usePromptRunStore.getState().patchRun(projectId, patch),
    getRun: (projectId) => usePromptRunStore.getState().byProjectId[projectId],
    launchPane: async (args) => {
      const steps = await launchPromptRunLanes({
        projectId: args.projectId,
        cwd: args.cwd,
        runId: args.runId,
        unrestricted: true,
        lanes: [
          {
            agent: args.agent,
            role: 'worker',
            taskKind: 'implement',
            reason: 'quota',
            skillNames: [],
            slicePrompt: args.bootstrap,
            paneName: args.name,
            independentSession: true,
            bootstrap: args.bootstrap,
          },
        ],
        createAgentTerminal: (projectId, launch) => useProjectsStore.getState().createAgentTerminal(projectId, launch),
      })
      const terminalId = steps[0]?.terminalId
      if (!terminalId) throw new Error('credit pane did not open')
      return { terminalId }
    },
    writePty,
    ptyIdFor: ptyIdForTerminal,
    toast: (toast) => useUiStore.getState().pushToast(toast),
    continueRun: continueSpecRun,
    finishIfSettled: finishSpecRunIfSettled,
    label: (agent) => AGENT_TYPE_LABELS[agent],
    copy: {
      waitTitle: translate(locale, 'runSpec.creditWaitTitle', { agent: label }),
      waitBody: translate(locale, 'runSpec.creditWaitBody'),
      openTitle: translate(locale, 'runSpec.creditOpenTitle', { agent: '{agent}' }),
      failTitle: translate(locale, 'runSpec.creditFailTitle'),
      failBody: translate(locale, 'runSpec.creditFailBody'),
    },
  }
}
