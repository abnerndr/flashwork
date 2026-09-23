import { getProjectDefaultCwd } from '../terminalFactory'
import { buildInterruptedResumePrompt } from './interruptedResume'
import { submitAutoPromptRun, toAutoPromptRunProject } from './submitAutoPromptRun'
import type { StartPromptRunResult } from './startPromptRun'
import type { PromptRun } from '../types'
import { useProjectsStore } from '../../stores/projectsStore'
import { usePromptRunStore } from '../../stores/promptRunStore'
import { useTaskBoardStore } from '../../stores/taskBoardStore'

/** Resume an interrupted Auto/board run via a fresh Auto route. */
export async function resumeInterruptedAuto(run: PromptRun): Promise<StartPromptRunResult> {
  const projects = useProjectsStore.getState()
  const project = projects.projects.find((item) => item.id === run.projectId) ?? null
  const cwd =
    run.cwd.trim() ||
    (project ? getProjectDefaultCwd(project, projects.projects) : '') ||
    ''

  const board = useTaskBoardStore.getState()
  const linkedCardIds = board.cards
    .filter((card) => card.projectId === run.projectId && card.runId === run.id)
    .map((card) => card.id)

  await usePromptRunStore.getState().discardInterrupted(run.projectId, run.id)

  for (const cardId of linkedCardIds) {
    board.patchCard(cardId, { needsResume: false })
  }

  const result = await submitAutoPromptRun({
    project: toAutoPromptRunProject(project),
    cwd,
    prompt: buildInterruptedResumePrompt(run),
    unrestricted: run.unrestricted,
  })

  if (result.ok) {
    for (const cardId of linkedCardIds) {
      useTaskBoardStore.getState().patchCard(cardId, {
        runId: result.run.id,
        column: 'doing',
        needsResume: false,
        error: undefined,
      })
    }
  }

  return result
}
