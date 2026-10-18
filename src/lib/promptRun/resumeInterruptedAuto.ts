import { getProjectDefaultCwd } from '../terminalFactory'
import { buildInterruptedResumePrompt } from './interruptedResume'
import { resumeSpecRun } from './runSpec'
import { submitAutoPromptRun, toAutoPromptRunProject } from './submitAutoPromptRun'
import type { StartPromptRunResult } from './startPromptRun'
import type { PromptRun } from '../types'
import { useProjectsStore } from '../../stores/projectsStore'
import { usePromptRunStore } from '../../stores/promptRunStore'

/** Resume an interrupted run: SPEC runs relaunch their unfinished tasks, older Auto runs reroute. */
export async function resumeInterruptedAuto(run: PromptRun): Promise<StartPromptRunResult> {
  const projects = useProjectsStore.getState()
  const project = projects.projects.find((item) => item.id === run.projectId) ?? null
  const cwd =
    run.cwd.trim() ||
    (project ? getProjectDefaultCwd(project, projects.projects) : '') ||
    ''

  await usePromptRunStore.getState().discardInterrupted(run.projectId, run.id)

  if (run.specTasks && run.specTasks.length > 0) {
    return resumeSpecRun({ ...run, cwd })
  }

  return submitAutoPromptRun({
    project: toAutoPromptRunProject(project),
    cwd,
    prompt: buildInterruptedResumePrompt(run),
  })
}
