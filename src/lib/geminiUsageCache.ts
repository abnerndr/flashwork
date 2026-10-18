import { getGeminiUsage } from './tauri'
import { makeTtlCache } from './ttlCache'

const TTL_MS = 60_000

export const getCachedGeminiUsage = makeTtlCache(getGeminiUsage, TTL_MS)
