import { Folder, Palette } from 'lucide-react'
import { nanoid } from 'nanoid'
import { useEffect, useRef, useState } from 'react'

import { pickDirectory } from '../../lib/dialog'
import { useT } from '../../lib/i18n'
import { isWindows } from '../../lib/platform'
import { bootstrapProjectRag } from '../../lib/projectRagBootstrap'
import {
  graphifyEnsureGraph,
  projectBootstrap,
  projectDetect,
  projectWriteRagStatus,
  wslPrepareFolder,
} from '../../lib/tauri'
import { GROUP_COLORS, type Project } from '../../lib/types'
import {
  explicitWslPreference,
  folderForNewProject,
  resolveProjectFolder,
  wslDistroFromPath,
} from '../../lib/wsl'
import { useGraphifySetupStore } from '../../stores/graphifySetupStore'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { Dropdown } from '../ui/Dropdown'
import { ColorPalettePopover } from './ColorPalettePopover'
import controls from './controls.module.css'
import { ImageInput } from './ImageInput'
import { Modal } from './Modal'
import { WslEnvironmentField } from './WslEnvironmentField'
import {
  clearedNewProjectConflictState,
  createProjectInFolder,
  isProjectFolderMissing,
  openExistingProject,
  shouldApplySubmitResult,
  type NewProjectRegistration,
} from './NewProjectModal.logic'

export function NewProjectModal() {
  const t = useT()
  const open = useUiStore((s) => s.openModal === 'newProject')
  const context = useUiStore((s) => s.modalContext) as {
    groupId?: string | null
    defaultCwd?: string
  } | null
  const closeModal = useUiStore((s) => s.closeModal)
  const createProject = useProjectsStore((s) => s.createProject)
  const setActiveProject = useProjectsStore((s) => s.setActiveProject)
  const openModal = useUiStore((s) => s.openModal_)
  const groups = useProjectsStore((s) => s.groups)

  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(GROUP_COLORS[0])
  const [iconUrl, setIconUrl] = useState('')
  const [defaultCwd, setDefaultCwd] = useState('')
  const [groupId, setGroupId] = useState<string | null>(context?.groupId ?? null)
  const [isColorPopoverOpen, setIsColorPopoverOpen] = useState(false)
  const [folderMissing, setFolderMissing] = useState(false)
  const [flashworkExists, setFlashworkExists] = useState(false)
  const [operationError, setOperationError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [wslDistro, setWslDistro] = useState('')
  const submitRequestId = useRef(0)

  useEffect(() => {
    if (!open || !isWindows()) return
    const preferences = useProjectsStore.getState().preferences
    setWslDistro(
      wslDistroFromPath(context?.defaultCwd) ??
        (preferences.wslEnabled ? preferences.wslDefaultDistro : ''),
    )
  }, [open, context?.defaultCwd])

  // A folder picked or typed under \\wsl.localhost\<distro> selects that distro.
  useEffect(() => {
    const derived = wslDistroFromPath(defaultCwd)
    if (derived) setWslDistro(derived)
  }, [defaultCwd])

  useEffect(() => {
    if (open && context?.defaultCwd) {
      submitRequestId.current += 1
      setSubmitting(false)
      setDefaultCwd(context.defaultCwd)
    }
  }, [open, context?.defaultCwd])

  const reset = () => {
    submitRequestId.current += 1
    setName('')
    setColor(GROUP_COLORS[0])
    setIconUrl('')
    setDefaultCwd('')
    setWslDistro('')
    setGroupId(context?.groupId ?? null)
    setIsColorPopoverOpen(false)
    const cleared = clearedNewProjectConflictState()
    setFolderMissing(cleared.folderMissing)
    setFlashworkExists(cleared.flashworkExists)
    setOperationError(cleared.operationError)
    setSubmitting(false)
  }

  const handleClose = () => {
    reset()
    closeModal()
  }

  const browse = async () => {
    try {
      const start = wslDistro
        ? await wslPrepareFolder(wslDistro, defaultCwd.trim() || '~')
        : defaultCwd || undefined
      const directory = await pickDirectory({ defaultPath: start })
      if (directory) {
        submitRequestId.current += 1
        setSubmitting(false)
        setDefaultCwd(directory)
        setFolderMissing(false)
        setFlashworkExists(false)
        setOperationError('')
      }
    } catch (error) {
      setOperationError(String(error))
    }
  }

  const registration = (): NewProjectRegistration => {
    const folder = folderForNewProject(defaultCwd, wslDistro || undefined, name)
    return {
      name: name.trim(),
      color,
      iconUrl: iconUrl.trim() || undefined,
      groupId,
      defaultCwd: resolveProjectFolder(folder, wslDistro || undefined),
      wslDistro: wslDistro || undefined,
    }
  }

  const finish = (project: Project) => {
    reset()
    setActiveProject(project.id)

    openModal('newTerminal', { projectId: project.id })
  }

  const submit = async () => {
    if (!name.trim() || submitting) return
    if (isProjectFolderMissing(defaultCwd)) {
      setFolderMissing(true)
      return
    }

    setFolderMissing(false)
    setFlashworkExists(false)
    setOperationError('')
    setSubmitting(true)
    const requestId = ++submitRequestId.current
    const shouldApplyResult = () => shouldApplySubmitResult(requestId, submitRequestId.current)
    try {
      const details = registration()
      if (wslDistro) details.defaultCwd = await wslPrepareFolder(wslDistro, defaultCwd, true)
      if (!shouldApplyResult()) return
      if (isWindows())
        useProjectsStore
          .getState()
          .setPreferences(explicitWslPreference(wslDistro))
      const result = await createProjectInFolder(details, {
        generateId: nanoid,
        projectBootstrap,
        bootstrapRag: async (folder) => {
          await bootstrapProjectRag(folder, {
            graphifyEnsureGraph,
            onGraphifyUnavailable: (missing) =>
              useGraphifySetupStore.getState().notifyMissing(missing),
            writeRagStatus: projectWriteRagStatus,
          })
        },
        createProject,
        shouldApplyResult,
      })
      if (!shouldApplyResult() || result.kind === 'stale') return
      if (result.kind === 'flashworkExists') {
        // Deleting a project only drops it from the list. `.flashwork` stays on disk,
        // so the same folder is registered again instead of blocking on that marker.
        const project = await openExistingProject(registration(), {
          projectDetect,
          findProject: (id) => useProjectsStore.getState().projects.find((item) => item.id === id),
          createProject,
          shouldApplyResult,
        })
        if (!shouldApplyResult() || !project) return
        finish(project)
        return
      }
      finish(result.project)
    } catch (error) {
      if (!shouldApplyResult()) return
      setOperationError(String(error))
    } finally {
      if (shouldApplyResult()) setSubmitting(false)
    }
  }

  const openExisting = async () => {
    setOperationError('')
    setSubmitting(true)
    const requestId = ++submitRequestId.current
    const shouldApplyResult = () => shouldApplySubmitResult(requestId, submitRequestId.current)
    try {
      const details = registration()
      if (wslDistro) details.defaultCwd = await wslPrepareFolder(wslDistro, defaultCwd)
      if (!shouldApplyResult()) return
      const project = await openExistingProject(details, {
        projectDetect,
        findProject: (id) => useProjectsStore.getState().projects.find((item) => item.id === id),
        createProject,
        shouldApplyResult,
      })
      if (!shouldApplyResult() || !project) return
      finish(project)
    } catch (error) {
      if (!shouldApplyResult()) return
      setOperationError(String(error))
    } finally {
      if (shouldApplyResult()) setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t('crud.newProjectTitle')}
      footer={
        <>
          <button type="button" className={controls.btn} onClick={handleClose}>
            {t('crud.cancel')}
          </button>
          <button
            type="button"
            className={`${controls.btn} ${controls.btnPrimary}`}
            disabled={!name.trim() || (!defaultCwd.trim() && !wslDistro) || submitting}
            onClick={() => void (flashworkExists ? openExisting() : submit())}
          >
            {flashworkExists ? t('crud.openExisting') : t('crud.create')}
          </button>
        </>
      }
    >
      <div className={controls.field}>
        <label className={controls.label}>{t('crud.nameLabel')}</label>
        <input
          className={controls.input}
          value={name}
          onChange={(e) => {
            submitRequestId.current += 1
            setSubmitting(false)
            setName(e.target.value)
          }}
          onKeyDown={(e) => e.key === 'Enter' && void (flashworkExists ? openExisting() : submit())}
          placeholder={t('crud.projectNamePlaceholder')}
        />
      </div>

      {groups.length > 0 ? (
        <div className={controls.field}>
          <label className={controls.label}>{t('crud.groupLabel')}</label>
          <Dropdown
            className={controls.input}
            value={groupId ?? ''}
            onChange={(value) => setGroupId(value || null)}
            ariaLabel={t('crud.groupLabel')}
            options={[
              { value: '', label: t('crud.noGroup') },
              ...groups.map((g) => ({ value: g.id, label: g.name })),
            ]}
          />
        </div>
      ) : null}

      <WslEnvironmentField
        value={wslDistro}
        onChange={(distro) => {
          submitRequestId.current += 1
          setSubmitting(false)
          setWslDistro(distro)
          const currentDistro = wslDistroFromPath(defaultCwd)
          if (currentDistro && currentDistro !== distro) setDefaultCwd('')
          setFlashworkExists(false)
          setOperationError('')
        }}
      />

      <div className={controls.field}>
        <label className={controls.label}>{t('crud.projectPathLabel')}</label>
        <div className={controls.cwdRow}>
          <div className={controls.cwdInputWrap}>
            <Folder size={15} aria-hidden="true" />
            <input
              className={controls.input}
              value={defaultCwd}
              onChange={(event) => {
                submitRequestId.current += 1
                setSubmitting(false)
                setDefaultCwd(event.target.value)
                setFolderMissing(false)
                setFlashworkExists(false)
                setOperationError('')
              }}
              placeholder={
                wslDistro ? t('wsl.folderPlaceholder') : t('crud.projectPathPlaceholder')
              }
              title={defaultCwd}
            />
          </div>
          <button type="button" className={controls.btn} onClick={() => void browse()}>
            {t('term.browse')}
          </button>
        </div>
        <span className={controls.hint}>
          {wslDistro
            ? defaultCwd.trim()
              ? t('wsl.folderHint')
              : t('wsl.folderEmptyHint', {
                  path: folderForNewProject('', wslDistro, name),
                  distro: wslDistro,
                })
            : t('crud.projectPathHint')}
        </span>
        {folderMissing ? (
          <span className={controls.fieldError}>{t('crud.folderRequired')}</span>
        ) : null}
        {flashworkExists ? (
          <span className={controls.fieldError}>{t('crud.flashworkExists')}</span>
        ) : null}
        {operationError ? (
          <span className={controls.fieldError}>
            {t('common.errorPrefix', { message: operationError })}
          </span>
        ) : null}
      </div>

      <div className={controls.field}>
        <label className={controls.label}>{t('crud.colorLabel')}</label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {GROUP_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              aria-label={t('crud.colorSwatch', { color: c })}
              style={{
                width: 24,
                height: 24,
                borderRadius: '50%',
                background: c,
                border: color === c ? '2px solid var(--fg)' : '2px solid transparent',
                cursor: 'pointer',
              }}
            />
          ))}

          {color && !GROUP_COLORS.some((preset) => preset === color) && (
            <button
              type="button"
              onClick={() => setIsColorPopoverOpen(true)}
              title={color}
              aria-label={t('crud.colorSwatch', { color })}
              style={{
                width: 24,
                height: 24,
                borderRadius: '50%',
                background: color,
                border: '2px solid var(--fg)',
                boxShadow: '0 0 0 1px var(--bg)',
                cursor: 'pointer',
              }}
            />
          )}

          {/* Botão de Paleta Completa / Mais Cores */}
          <button
            type="button"
            onClick={() => setIsColorPopoverOpen(true)}
            title={t('crud.moreColors')}
            aria-label={t('crud.moreColors')}
            style={{
              width: 24,
              height: 24,
              borderRadius: '50%',
              background: 'var(--panel-hover)',
              border: '1px solid var(--border-strong)',
              display: 'grid',
              placeItems: 'center',
              color: 'var(--fg-muted)',
              cursor: 'pointer',
            }}
          >
            <Palette size={16} />
          </button>
        </div>
      </div>

      <ImageInput
        label={t('crud.iconLabel')}
        value={iconUrl}
        onChange={setIconUrl}
        onEnter={submit}
        previewColor={color}
        hint={t('crud.projectIconHint')}
      />

      <ColorPalettePopover
        open={isColorPopoverOpen}
        onClose={() => setIsColorPopoverOpen(false)}
        onSelectColor={(selected) => setColor(selected)}
        selectedColor={color}
      />
    </Modal>
  )
}
