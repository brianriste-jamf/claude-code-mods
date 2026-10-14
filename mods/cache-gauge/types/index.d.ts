export type Snapshot = {
  /** Input tokens of the last main-loop response (what the next request re-sends). */
  ctxTokens: number
  /** The model's context window. */
  window: number
  /** Auto-compact threshold in tokens, when auto-compaction is on. */
  compactAt: number | null
  /** $.clock.now() when the last main-loop response finished. */
  respondedAt: number
  model: string
  /** USD per uncached input token, calibrated from /cost or the list-price fallback. */
  baseUsd: number
  isCalibrated: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'cache-gauge': { snapshot: Snapshot | null; isHidden: boolean; now: number }
  }
}
