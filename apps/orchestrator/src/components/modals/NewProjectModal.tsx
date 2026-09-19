import { Folder, Network, Palette, Terminal } from 'lucide-react'
import { nanoid } from 'nanoid'
import { useEffect, useRef, useState } from 'react'

import { pickDirectory } from '../../lib/dialog'
import { AGENT_SANDBOX_ENABLED } from '../../lib/featureFlags'
import { useT } from '../../lib/i18n'
import { bootstrapProjectRag } from '../../lib/projectRagBootstrap'
import {
  aiMemoryMcpConfigPath,
  graphifyEnsureGraph,
  projectBootstrap,
  projectDetect,
  projectWriteRagStatus,
} from '../../lib/tauri'
import { GROUP_COLORS, type Project } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { Dropdown } from '../ui/Dropdown'
import { ColorPalettePopover } from './ColorPalettePopover'
import controls from './controls.module.css'
import { ImageInput } from './ImageInput'
import { Modal } from './Modal'
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
  const setActiveView = useUiStore((s) => s.setActiveView)
  const groups = useProjectsStore((s) => s.groups)

  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(GROUP_COLORS[0])
  const [iconUrl, setIconUrl] = useState('')
  const [defaultCwd, setDefaultCwd] = useState('')
  const [mode, setMode] = useState<'standard' | 'agentSandbox'>('standard')
  const [groupId, setGroupId] = useState<string | null>(context?.groupId ?? null)
  const [isColorPopoverOpen, setIsColorPopoverOpen] = useState(false)
  const [folderMissing, setFolderMissing] = useState(false)
  const [flashworkExists, setFlashworkExists] = useState(false)
  const [operationError, setOperationError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const submitRequestId = useRef(0)

                                                                        
                                                                       
                                        
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
    setMode('standard')
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
    const directory = await pickDirectory({ defaultPath: defaultCwd || undefined })
    if (directory) {
      submitRequestId.current += 1
      setSubmitting(false)
      setDefaultCwd(directory)
      setFolderMissing(false)
      setFlashworkExists(false)
      setOperationError('')
    }
  }

  const registration = (): NewProjectRegistration => ({
    name: name.trim(),
    mode,
    color,
    iconUrl: iconUrl.trim() || undefined,
    groupId,
    defaultCwd,
  })

  const finish = (project: Project) => {
    reset()
    setActiveProject(project.id)

    if (project.mode === 'agentSandbox') {
      setActiveView('agentSandbox')
      closeModal()
      return
    }

    openModal('newTerminal', { projectId: project.id })
  }

  const submit = async () => {
    if (!name.trim()) return
    if (isProjectFolderMissing(defaultCwd)) {
      setFolderMissing(true)
      return
    }

    setFolderMissing(false)
    setFlashworkExists(false)
    setOperationError('')
    setSubmitting(true)
    const requestId = ++submitRequestId.current
    const shouldApplyResult = () =>
      shouldApplySubmitResult(requestId, submitRequestId.current)
    try {
      const result = await createProjectInFolder(registration(), {
        generateId: nanoid,
        projectBootstrap,
        bootstrapRag: async (folder) => {
          const features = useProjectsStore.getState().preferences.enabledFeatures
          await bootstrapProjectRag(folder, {
            graphifyEnabled: features.graphify,
            aiMemoryEnabled: features.aiMemory,
            graphifyEnsureGraph,
            aiMemoryMcpConfigPath,
            writeRagStatus: projectWriteRagStatus,
          })
        },
        createProject,
        shouldApplyResult,
      })
      if (!shouldApplyResult() || result.kind === 'stale') return
      if (result.kind === 'flashworkExists') {
        setFlashworkExists(true)
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
    const shouldApplyResult = () =>
      shouldApplySubmitResult(requestId, submitRequestId.current)
    try {
      const project = await openExistingProject(registration(), {
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
            disabled={!name.trim() || !defaultCwd.trim() || submitting}
            onClick={() => void (flashworkExists ? openExisting() : submit())}
          >
            {flashworkExists
              ? t('crud.openExisting')
              : mode === 'agentSandbox'
                ? t('crud.createAgentSandboxProject')
                : t('crud.create')}
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
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
          placeholder={t('crud.projectNamePlaceholder')}
        />
      </div>

      {AGENT_SANDBOX_ENABLED ? (
        <div className={controls.field}>
          <label className={controls.label}>{t('crud.projectModeLabel')}</label>
          <div
            className={controls.modeChoices}
            role="radiogroup"
            aria-label={t('crud.projectModeLabel')}
          >
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'standard'}
              className={`${controls.modeChoice} ${mode === 'standard' ? controls.modeChoiceActive : ''}`}
              onClick={() => setMode('standard')}
            >
              <Terminal size={16} aria-hidden="true" />
              <span className={controls.modeChoiceBody}>
                <strong>{t('crud.projectModeStandard')}</strong>
                <small>{t('crud.projectModeStandardHint')}</small>
              </span>
              <span className={controls.modeChoiceIndicator} aria-hidden="true" />
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'agentSandbox'}
              className={`${controls.modeChoice} ${mode === 'agentSandbox' ? controls.modeChoiceActive : ''}`}
              onClick={() => setMode('agentSandbox')}
            >
              <Network size={16} aria-hidden="true" />
              <span className={controls.modeChoiceBody}>
                <strong>{t('crud.projectModeSandbox')}</strong>
                <small>{t('crud.projectModeSandboxHint')}</small>
              </span>
              <span className={controls.modeChoiceIndicator} aria-hidden="true" />
            </button>
          </div>
          <span className={controls.hint}>{t('crud.projectModeSelectionHint')}</span>
        </div>
      ) : null}

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
              placeholder={t('crud.projectPathPlaceholder')}
              title={defaultCwd}
            />
          </div>
          <button type="button" className={controls.btn} onClick={() => void browse()}>
            {t('term.browse')}
          </button>
        </div>
        <span className={controls.hint}>{t('crud.projectPathHint')}</span>
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
            <Palette size={13} />
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
