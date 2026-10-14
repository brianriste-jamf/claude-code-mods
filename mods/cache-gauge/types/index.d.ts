export type Snapshot = {
  /** Input tokens of the last main-loop response (what the next request re-sends). */
  ctxTokens: number
  window: number
  /** Auto-compact threshold in tokens, when auto-compaction is on. */
  compactAt: number | null
  /** cache_read / all input tokens of the last turn, 0..1. */
  hitRatio: number
  /** $.clock.now() when the last main-loop response finished. */
  respondedAt: number
  model: string
  /** USD per uncached input token, calibrated from /cost or the list-price fallback. */
  baseUsd: number
  isCalibrated: boolean
  sessionUsd: number
}

declare module 'claude-code' {
  interface PluginState {
    'cache-gauge': { snapshot: Snapshot | null; isHidden: boolean; now: number }
  }
}
