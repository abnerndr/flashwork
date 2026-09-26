import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi'
import { getCurrentWindow, type Monitor } from '@tauri-apps/api/window'

type Frame = { x: number; y: number; width: number; height: number }

/** True after we used setFullscreen / manual fill instead of native maximize. */
let filledManually = false
let restoreFrame: Frame | null = null

function isLinuxHost(): boolean {
  return /linux/i.test(navigator.userAgent) || /linux/i.test(navigator.platform)
}

function pickMonitor(monitors: Monitor[]): Monitor {
  return monitors.reduce((best, monitor) => {
    const a = monitor.position
    const b = best.position
    if (a.x < b.x) return monitor
    if (a.x === b.x && a.y < b.y) return monitor
    return best
  })
}

/** Reject the bogus 8k virtual root some WSLg builds report. */
function saneMonitor(monitor: Monitor): boolean {
  const { width, height } = monitor.size
  return width >= 800 && height >= 600 && width <= 5120 && height <= 3240
}

function notifyLayout(): void {
  window.dispatchEvent(new Event('resize'))
}

async function saveFrame(): Promise<void> {
  const win = getCurrentWindow()
  const [position, size] = await Promise.all([
    win.outerPosition().catch(() => null),
    win.outerSize().catch(() => null),
  ])
  if (position && size) {
    restoreFrame = {
      x: position.x,
      y: position.y,
      width: size.width,
      height: size.height,
    }
  }
}

async function restoreSavedFrame(): Promise<void> {
  const win = getCurrentWindow()
  if (!restoreFrame) return
  await win
    .setPosition(new PhysicalPosition(restoreFrame.x, restoreFrame.y))
    .catch(() => {})
  await win
    .setSize(new PhysicalSize(restoreFrame.width, restoreFrame.height))
    .catch(() => {})
  restoreFrame = null
}

/**
 * Maximize / restore. On Windows-hosted WSL, undecorated GTK maximize is
 * unreliable — prefer fullscreen, then a monitor-bounds fill if needed.
 */
export async function toggleFlashworkMaximize(): Promise<void> {
  const win = getCurrentWindow()
  const [wasFullscreen, wasMaximized] = await Promise.all([
    win.isFullscreen().catch(() => false),
    win.isMaximized().catch(() => false),
  ])

  if (wasFullscreen || wasMaximized || filledManually) {
    filledManually = false
    await win.setFullscreen(false).catch(() => {})
    await win.unmaximize().catch(() => {})
    await restoreSavedFrame()
    notifyLayout()
    return
  }

  await saveFrame()

  if (isLinuxHost()) {
    // Fullscreen is the reliable path under WSLg + decorations:false.
    await win.setFullscreen(true).catch(() => {})
    await new Promise((resolve) => window.setTimeout(resolve, 50))
    const fs = await win.isFullscreen().catch(() => false)
    if (fs) {
      filledManually = true
      notifyLayout()
      return
    }

    const [current, monitors] = await Promise.all([
      win.currentMonitor().catch(() => null),
      win.availableMonitors().catch(() => [] as Monitor[]),
    ])
    const candidates = [current, ...monitors].filter(
      (monitor): monitor is Monitor => Boolean(monitor && saneMonitor(monitor)),
    )
    const monitor = candidates[0] ?? (monitors.length > 0 ? pickMonitor(monitors) : null)
    if (monitor && saneMonitor(monitor)) {
      filledManually = true
      await win
        .setPosition(new PhysicalPosition(monitor.position.x, monitor.position.y))
        .catch(() => {})
      await win
        .setSize(new PhysicalSize(monitor.size.width, monitor.size.height))
        .catch(() => {})
      notifyLayout()
      return
    }
  }

  await win.maximize().catch(() => win.toggleMaximize().catch(() => {}))
  notifyLayout()
}
