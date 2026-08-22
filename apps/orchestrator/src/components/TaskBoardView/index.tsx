import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { FolderKanban, Plus, Square, Trash2, X } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import { pickFiles } from '../../lib/dialog'
import { useT, type MessageKey } from '../../lib/i18n'
import {
  cardDragId,
  columnDropId,
  parseBoardDrop,
  TASK_BOARD_COLUMNS,
} from '../../lib/taskBoard/boardDnd'
import { boardErrorMessageKey } from '../../lib/taskBoard/boardStart'
import { toCwdRelative } from '../../lib/taskBoard/schedule'
import { pumpTaskBoardQueue, stopBoardCard } from '../../lib/taskBoard/submitBoardTask'
import { getProjectDefaultCwd } from '../../lib/terminalFactory'
import { AGENT_TYPE_LABELS, type TaskBoardColumn, type TaskCard } from '../../lib/types'
import { selectActiveProject, useProjectsStore } from '../../stores/projectsStore'
import { createTaskCardDraft, useTaskBoardStore } from '../../stores/taskBoardStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './TaskBoardView.module.css'

const COLUMN_KEYS: Record<TaskBoardColumn, MessageKey> = {
  backlog: 'taskBoard.column.backlog',
  todo: 'taskBoard.column.todo',
  doing: 'taskBoard.column.doing',
  verify: 'taskBoard.column.verify',
  done: 'taskBoard.column.done',
  blocked: 'taskBoard.column.blocked',
}

function cardErrorText(error: string, t: (key: MessageKey) => string): string {
  const key = boardErrorMessageKey(error)
  return key ? t(key) : error
}

function BoardColumn({
  column,
  count,
  title,
  children,
}: {
  column: TaskBoardColumn
  count: number
  title: string
  children: ReactNode
}) {
  const droppable = useDroppable({ id: columnDropId(column) })
  return (
    <section
      ref={droppable.setNodeRef}
      className={`${styles.column} ${droppable.isOver ? styles.columnOver : ''}`}
    >
      <header>
        <h2>{title}</h2>
        <span>{count}</span>
      </header>
      <div className={styles.stack}>{children}</div>
    </section>
  )
}

function BoardCard({
  card,
  onOpen,
  onRemove,
}: {
  card: TaskCard
  onOpen: (card: TaskCard) => void
  onRemove: (cardId: string) => void
}) {
  const t = useT()
  const draggable = useDraggable({ id: cardDragId(card.id) })
  const style = draggable.transform
    ? { transform: `translate3d(${draggable.transform.x}px, ${draggable.transform.y}px, 0)` }
    : undefined
  return (
    <article
      ref={draggable.setNodeRef}
      className={`${styles.card} ${draggable.isDragging ? styles.cardDragging : ''}`}
      style={style}
      {...draggable.attributes}
      {...draggable.listeners}
    >
      <div className={styles.cardTop}>
        <strong>{card.title}</strong>
        <button
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onRemove(card.id)}
          aria-label={t('common.remove')}
        >
          <Trash2 size={12} />
        </button>
      </div>
      <p>{card.prompt}</p>
      <div className={styles.meta}>
        <span>P{card.priority}</span>
        {card.allowedFiles.length > 0 ? (
          <span>{t('taskBoard.fileCount', { count: String(card.allowedFiles.length) })}</span>
        ) : (
          <span>{t('taskBoard.wholeRepo')}</span>
        )}
      </div>
      {card.slicePlan && card.slicePlan.length > 0 ? (
        <ul className={styles.slices}>
          {card.slicePlan.map((slice) => (
            <li key={slice.id}>
              {AGENT_TYPE_LABELS[slice.agent]} · {slice.kind} · {slice.status}
            </li>
          ))}
        </ul>
      ) : null}
      {card.error ? <p className={styles.error}>{cardErrorText(card.error, t)}</p> : null}
      {card.column === 'doing' || card.column === 'verify' ? (
        <div className={styles.cardActions}>
          <button
            type="button"
            className={styles.open}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onOpen(card)}
          >
            {t('taskBoard.openWorkspace')}
          </button>
          {card.column === 'doing' ? (
            <button
              type="button"
              className={styles.open}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => stopBoardCard(card.id)}
            >
              <Square size={10} />
              {t('taskBoard.stop')}
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

export function TaskBoardView() {
  const t = useT()
  const projects = useProjectsStore((state) => state.projects)
  const activeProject = useProjectsStore(selectActiveProject)
  const cards = useTaskBoardStore((state) => state.cards)
  const upsertCard = useTaskBoardStore((state) => state.upsertCard)
  const setColumn = useTaskBoardStore((state) => state.setColumn)
  const removeCard = useTaskBoardStore((state) => state.removeCard)
  const setActiveProject = useProjectsStore((state) => state.setActiveProject)
  const setActiveView = useUiStore((state) => state.setActiveView)
  const requestPaneFocus = useUiStore((state) => state.requestPaneFocus)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [priority, setPriority] = useState(3)
  const [files, setFiles] = useState<string[]>([])
  const [verify, setVerify] = useState('')
  const [projectId, setProjectId] = useState(activeProject?.id ?? projects[0]?.id ?? '')

  const project = projects.find((item) => item.id === projectId) ?? activeProject ?? projects[0]
  const cwd = getProjectDefaultCwd(project, projects)

  const byColumn = useMemo(() => {
    const grouped: Record<TaskBoardColumn, TaskCard[]> = {
      backlog: [],
      todo: [],
      doing: [],
      verify: [],
      done: [],
      blocked: [],
    }
    for (const card of cards) grouped[card.column].push(card)
    for (const column of TASK_BOARD_COLUMNS) {
      grouped[column].sort((left, right) => left.priority - right.priority || left.createdAt - right.createdAt)
    }
    return grouped
  }, [cards])

  const createCard = () => {
    if (!project || !title.trim() || !prompt.trim()) return
    upsertCard(
      createTaskCardDraft({
        projectId: project.id,
        cwd,
        title: title.trim(),
        prompt: prompt.trim(),
        allowedFiles: files,
        priority,
        verifyCommands: verify
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      }),
    )
    setTitle('')
    setPrompt('')
    setFiles([])
    setVerify('')
  }

  const openCard = (card: TaskCard) => {
    const terminalId = card.slicePlan?.find((slice) => slice.terminalId)?.terminalId
    setActiveProject(card.projectId)
    setActiveView('workspace')
    if (terminalId) requestPaneFocus(terminalId)
  }

  const onDragEnd = (event: DragEndEvent) => {
    const drop = parseBoardDrop(event.active.id, event.over?.id)
    if (!drop) return
    setColumn(drop.cardId, drop.column)
    if (drop.column === 'todo') window.setTimeout(() => pumpTaskBoardQueue(), 0)
  }

  return (
    <div className={styles.board}>
      <header className={styles.header}>
        <div>
          <p className={styles.kicker}>{t('taskBoard.kicker')}</p>
          <h1>
            <FolderKanban size={18} />
            {t('taskBoard.title')}
          </h1>
          <p className={styles.lede}>{t('taskBoard.lede')}</p>
        </div>
      </header>

      <form
        className={styles.composer}
        onSubmit={(event) => {
          event.preventDefault()
          createCard()
        }}
      >
        <label>
          {t('taskBoard.project')}
          <select value={project?.id ?? ''} onChange={(event) => setProjectId(event.target.value)}>
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.grow}>
          {t('taskBoard.cardTitle')}
          <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} />
        </label>
        <label>
          {t('taskBoard.priority')}
          <input
            type="number"
            min={1}
            max={9}
            value={priority}
            onChange={(event) => setPriority(Number(event.target.value) || 3)}
          />
        </label>
        <label className={styles.full}>
          {t('taskBoard.prompt')}
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={3} />
        </label>
        <div className={styles.files}>
          <div className={styles.filesHead}>
            <span>{t('taskBoard.files')}</span>
            <button
              type="button"
              onClick={() => {
                void pickFiles({ defaultPath: cwd || undefined }).then((picked) => {
                  if (!picked) return
                  setFiles((current) => {
                    const next = [...current]
                    for (const path of picked) {
                      const relative = cwd ? toCwdRelative(cwd, path) : path
                      if (!next.includes(relative)) next.push(relative)
                    }
                    return next
                  })
                })
              }}
            >
              <Plus size={12} />
              {t('taskBoard.addFiles')}
            </button>
          </div>
          {files.length === 0 ? (
            <p className={styles.hint}>{t('taskBoard.filesHint')}</p>
          ) : (
            <ul>
              {files.map((file) => (
                <li key={file}>
                  <span>{file}</span>
                  <button type="button" onClick={() => setFiles((current) => current.filter((item) => item !== file))}>
                    <X size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <label className={styles.full}>
          {t('taskBoard.verify')}
          <textarea
            value={verify}
            onChange={(event) => setVerify(event.target.value)}
            rows={2}
            placeholder={t('taskBoard.verifyHint')}
          />
        </label>
        <button type="submit" className={styles.submit} disabled={!project || !title.trim() || !prompt.trim()}>
          {t('taskBoard.create')}
        </button>
      </form>

      <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragEnd={onDragEnd}>
        <div className={styles.columns}>
          {TASK_BOARD_COLUMNS.map((column) => (
            <BoardColumn
              key={column}
              column={column}
              count={byColumn[column].length}
              title={t(COLUMN_KEYS[column])}
            >
              {byColumn[column].map((card) => (
                <BoardCard key={card.id} card={card} onOpen={openCard} onRemove={removeCard} />
              ))}
            </BoardColumn>
          ))}
        </div>
      </DndContext>
    </div>
  )
}
