import { getLocale, translate } from './i18n'
import { getProjectDefaultCwd } from './terminalFactory'
import { isAbsoluteFsPath, workspaceRelFromAbs } from './workspaceRel'
import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'

function posixRel(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '')
}

function isEscapingRel(rel: string): boolean {
  return !rel || rel.split('/').some((segment) => segment === '..')
}

/** Map `absOrRel` onto the editor pane cwd. Absolute paths must sit under cwd. */
export function resolveEditorOpenRel(cwd: string, absOrRel: string): string | null {
  if (isAbsoluteFsPath(absOrRel)) {
    return workspaceRelFromAbs(cwd, absOrRel)
  }
  const normalized = posixRel(absOrRel.trim())
  return isEscapingRel(normalized) ? null : normalized
}

/** Ensure an editor pane exists and open `absOrRel` as a tab. Reuses a single editor pane per project. */
export function openSourceInEditor(projectId: string, absOrRel: string): void {
  const projects = useProjectsStore.getState()
  const ui = useUiStore.getState()
  const project = projects.projects.find((item) => item.id === projectId)
  if (!project) return

  const existing = project.terminals.find((term) => term.kind === 'editor')
  const cwd =
    existing?.cwd?.trim() || getProjectDefaultCwd(project, projects.projects)
  if (!cwd) {
    ui.pushToast({
      title: translate(getLocale(), 'editor.noCwdTitle'),
      body: translate(getLocale(), 'editor.noCwdBody'),
    })
    return
  }

  const rel = resolveEditorOpenRel(cwd, absOrRel)

  if (!rel) {
    ui.pushToast({
      title: translate(getLocale(), 'editor.errPathEscape'),
      body: absOrRel,
    })
    return
  }

  if (existing) {
    projects.openPane(projectId, existing.id)
    ui.requestPaneFocus(existing.id)
  } else {
    const pane = projects.createEditorPane(projectId, cwd)
    ui.requestPaneFocus(pane.id)
  }
  ui.setActiveView('workspace')
  ui.requestEditorOpen(projectId, rel)
}
