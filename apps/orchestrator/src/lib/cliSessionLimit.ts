import type { AgentType } from './types'
import type {
  AntigravityUsage,
  ClaudeUsage,
  CodexUsage,
  GeminiUsage,
  OpenCodeUsageSummary,
} from './tauri'

export type CliUsageBundle = {
  claude: ClaudeUsage | null
  codex: CodexUsage | null
  antigravity: AntigravityUsage | null
  gemini: GeminiUsage | null
  opencode: OpenCodeUsageSummary | null
}

export type CliSessionSnapshot = {
  /** Percent used in the primary session window, when the vendor exposes one. */
  usedPercent: number | null
  /** Short window label from the vendor (`5h`, `3h`, `7d`) or a local spend hint. */
  windowLabel: string
  /** Compact chip for pickers / Auto bar — e.g. `72% · 5h`. */
  badge: string
  critical: boolean
}

/** Format a rate-limit window length reported in minutes. */
export function formatWindowMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return ''
  if (minutes < 60) return `${Math.round(minutes)}m`
  const hours = minutes / 60
  if (hours < 40) return `${Math.round(hours)}h`
  return `${Math.max(1, Math.round(hours / 24))}d`
}

function pctBadge(usedPercent: number, windowLabel: string): string {
  return `${Math.round(usedPercent)}% · ${windowLabel}`
}

/**
 * Live session-limit snapshot for a CLI, when Flashwork has usage data.
 * Returns null when there is nothing useful to show (shell, unsigned-in, etc.).
 */
export function resolveCliSessionSnapshot(
  agent: AgentType,
  usage: CliUsageBundle,
): CliSessionSnapshot | null {
  switch (agent) {
    case 'claude': {
      const window = usage.claude?.five_hour
      if (!window) return null
      const windowLabel = '5h'
      return {
        usedPercent: window.utilization,
        windowLabel,
        badge: pctBadge(window.utilization, windowLabel),
        critical: window.utilization >= 80,
      }
    }
    case 'codex': {
      const primary = usage.codex?.primary
      if (!primary) return null
      const windowLabel = formatWindowMinutes(primary.window_minutes) || '5h'
      return {
        usedPercent: primary.used_percent,
        windowLabel,
        badge: pctBadge(primary.used_percent, windowLabel),
        critical: Boolean(usage.codex?.rate_limited) || primary.used_percent >= 80,
      }
    }
    case 'antigravity': {
      const ag = usage.antigravity
      if (!ag || ag.status !== 'ready') return null
      const windowLabel = ag.buckets[0]?.label?.trim() || 'quota'
      return {
        usedPercent: ag.used_percent,
        windowLabel,
        badge: pctBadge(ag.used_percent, windowLabel),
        critical: ag.rate_limited || ag.used_percent >= 80,
      }
    }
    case 'gemini': {
      const gemini = usage.gemini
      if (!gemini || (gemini.session_count <= 0 && gemini.total_tokens <= 0)) return null
      return {
        usedPercent: null,
        windowLabel: 'today',
        badge: `${gemini.session_count} · today`,
        critical: false,
      }
    }
    case 'opencode': {
      const oc = usage.opencode
      if (!oc) return null
      const tokens = oc.input_tokens + oc.output_tokens
      if (oc.session_count <= 0 && tokens <= 0) return null
      return {
        usedPercent: null,
        windowLabel: '24h',
        badge: `${oc.session_count} · 24h`,
        critical: false,
      }
    }
    default:
      return null
  }
}
