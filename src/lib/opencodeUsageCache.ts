import { getOpenCodeUsageSummary } from './tauri'
import { makeTtlCache } from './ttlCache'

const TTL_MS = 60_000

export const getCachedOpenCodeUsage = makeTtlCache(() => getOpenCodeUsageSummary(24), TTL_MS)
