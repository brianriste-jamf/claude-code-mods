export type Snapshot = {
  /** Input tokens of the last main-loop response (what the next request re-sends). */
  ctxTokens: number
  /** The model's context window. */
  window: number
  /** Auto-compact threshold in tokens, when auto-compaction is on. */
  compactAt: number | null
  /** $.clock.now() when the last main-loop response finished; null before one did (seeded at start). */
  respondedAt: number | null
  /** A compaction ran since that response: its new prefix is not cached yet. */
  isCompacted: boolean
  /** The model that answered last: the one whose cache holds the context. */
  model: string
  /** The model the next message goes to; differs from `model` after `/model`, whose switch leaves the cache behind. */
  currentModel: string
  /** USD per uncached input token on `currentModel`, calibrated from /cost or the list-price fallback. */
  baseUsd: number
  isCalibrated: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'cache-gauge': { snapshot: Snapshot | null; isHidden: boolean; now: number; isCompacting: boolean; isAgentsBusy: boolean }
  }
}
