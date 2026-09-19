import { nanoid } from 'nanoid'
import { create } from 'zustand'

import { deleteTaskCard, listTaskCards, saveTaskCard } from '../lib/tauri'
import { useProjectsStore } from './projectsStore'
import type {
  TaskAttachment,
  TaskBoardColumn,
  TaskCard,
  TaskSlicePlan,
  TaskToolSelection,
} from '../lib/types'

type TaskBoardState = {
  cards: TaskCard[]
  hydrated: boolean
  hydrate: () => Promise<void>
  upsertCard: (card: TaskCard) => void
  patchCard: (cardId: string, patch: Partial<TaskCard>) => void
  setColumn: (cardId: string, column: TaskBoardColumn) => void
  setSlicePlan: (cardId: string, slicePlan: TaskSlicePlan[]) => void
  removeCard: (cardId: string) => void
}

const persistTimers = new Map<string, number>()

function persist(card: TaskCard): void {
  const write = () => {
    persistTimers.delete(card.id)
    void saveTaskCard(card).catch((cause) => {
      console.warn('[task-board] persist failed:', cause)
    })
  }
  if (typeof window === 'undefined') {
    write()
    return
  }
  const previous = persistTimers.get(card.id)
  if (previous != null) window.clearTimeout(previous)
  persistTimers.set(card.id, window.setTimeout(write, 250))
}

export const useTaskBoardStore = create<TaskBoardState>((set, get) => ({
  cards: [],
  hydrated: false,
  hydrate: async () => {
    try {
      const projectFolders = useProjectsStore
        .getState()
        .projects.filter((project) => Boolean(project.defaultCwd?.trim()))
        .map((project) => ({
          projectId: project.id,
          folder: project.defaultCwd!.trim(),
        }))
      const cards = await listTaskCards(undefined, projectFolders)
      set({ cards, hydrated: true })
    } catch (cause) {
      console.warn('[task-board] hydrate failed:', cause)
      set({ hydrated: true })
    }
  },
  upsertCard: (card) => {
    set((state) => {
      const index = state.cards.findIndex((item) => item.id === card.id)
      const cards = [...state.cards]
      if (index >= 0) cards[index] = card
      else cards.unshift(card)
      return { cards }
    })
    persist(card)
  },
  patchCard: (cardId, patch) => {
    const current = get().cards.find((card) => card.id === cardId)
    if (!current) return
    const next = { ...current, ...patch, updatedAt: Date.now() }
    get().upsertCard(next)
  },
  setColumn: (cardId, column) => {
    get().patchCard(cardId, { column })
  },
  setSlicePlan: (cardId, slicePlan) => {
    get().patchCard(cardId, { slicePlan })
  },
  removeCard: (cardId) => {
    const card = get().cards.find((item) => item.id === cardId)
    set((state) => ({ cards: state.cards.filter((item) => item.id !== cardId) }))
    void deleteTaskCard(cardId, card?.cwd, card?.projectId).catch((cause) => {
      console.warn('[task-board] delete failed:', cause)
    })
  },
}))

export function createTaskCardDraft(input: {
  projectId: string
  cwd: string
  title: string
  prompt: string
  allowedFiles: string[]
  priority: number
  verifyCommands?: string[]
  attachments?: TaskAttachment[]
  toolSelection?: TaskToolSelection
  now?: () => number
  createId?: () => string
}): TaskCard {
  const now = input.now ?? Date.now
  const createdAt = now()
  return {
    id: (input.createId ?? nanoid)(),
    projectId: input.projectId,
    cwd: input.cwd,
    title: input.title.trim(),
    prompt: input.prompt.trim(),
    allowedFiles: input.allowedFiles,
    priority: input.priority,
    column: 'backlog',
    verifyCommands: input.verifyCommands,
    attachments: input.attachments ?? [],
    toolSelection: input.toolSelection ?? {
      mode: 'projectDefault',
      mcpServerIds: [],
      skillNames: [],
    },
    createdAt,
    updatedAt: createdAt,
  }
}
