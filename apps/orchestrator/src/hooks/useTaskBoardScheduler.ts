import { useEffect } from 'react'

import { pumpTaskBoardQueue } from '../lib/taskBoard/submitBoardTask'
import { useProjectsStore } from '../stores/projectsStore'
import { usePromptRunStore } from '../stores/promptRunStore'
import { useTaskBoardStore } from '../stores/taskBoardStore'

export function useTaskBoardScheduler() {
  const hydrated = useProjectsStore((state) => state.hydrated)
  const boardHydrated = useTaskBoardStore((state) => state.hydrated)

  useEffect(() => {
    if (!hydrated) return
    void useTaskBoardStore.getState().hydrate()
  }, [hydrated])

  useEffect(() => {
    if (!hydrated || !boardHydrated) return
    let timer: number | null = null
    const pumpSoon = () => {
      if (timer != null) return
      timer = window.setTimeout(() => {
        timer = null
        pumpTaskBoardQueue()
      }, 80)
    }
    pumpTaskBoardQueue()
    const unsubBoard = useTaskBoardStore.subscribe(pumpSoon)
    const unsubRun = usePromptRunStore.subscribe(pumpSoon)
    return () => {
      unsubBoard()
      unsubRun()
      if (timer != null) window.clearTimeout(timer)
    }
  }, [boardHydrated, hydrated])
}
