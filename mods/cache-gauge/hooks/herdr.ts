import type { Snapshot } from '../types'
import { gaugeState } from './pricing'
import type { Ttl } from './pricing'

// herdr's longest token lifetime: a crashed session's ctx is gone by then.
const CTX_TTL_MS = 86_400_000
const MINUTE = 60_000

type Run = (argv: string[]) => Promise<{ stdout: string }>

/**
 * Reports the gauge as herdr pane metadata tokens (`cache`, `ctx`) when the session runs in a herdr pane.
 * Off outside herdr, and a herdr that is missing or fails never reaches the gauge.
 */
export const createHerdr = (ttl: Ttl) => {
  let run: Run
  let paneId = ''
  let sentCache: string | null = null
  let sentCtx: string | null = null
  let isWorking = false
  // One call at a time, so a quick warm then cold lands in order.
  let queue: Promise<unknown> = Promise.resolve()

  const call = (...args: string[]) => {
    const argv = ['herdr', 'pane', 'report-metadata', paneId, '--source', 'cache-gauge', ...args]
    queue = queue.then(() => run(argv)).catch(() => {})
  }
  // herdr deletes an expired token, so a token carries its lifetime as a backstop.
  const send = (token: string, ttlMs?: number) =>
    call('--token', token, ...(ttlMs === undefined ? [] : ['--ttl-ms', String(ttlMs)]))

  return {
    get isOn() {
      return paneId !== ''
    },

    /** herdr sets HERDR_PANE_ID in the pane's environment; a child process inherits it. */
    async detect(runner: Run) {
      run = runner
      try {
        paneId = (await run(['sh', '-c', 'printf %s "$HERDR_PANE_ID"'])).stdout.trim()
      } catch {
        paneId = ''
      }
    },

    /** Mid-turn every request restarts the lifetime, so the cache token drops its countdown. */
    setWorking(value: boolean) {
      isWorking = value
    },

    /** Removes both tokens, for a session that ends; resolves once herdr has been called. */
    async clear() {
      if (paneId === '') {
        return
      }
      sentCache = null
      sentCtx = null
      call('--clear-token', 'cache', '--clear-token', 'ctx')
      await queue
    },

    /** Sends what changed since the last report. */
    report(snap: Snapshot | null, t: number) {
      if (paneId === '' || snap === null) {
        return
      }
      const { ctx, leftMs, isWarm } = gaugeState(snap, ttl, t)
      // The countdown steps once a minute: `warm 5m` down to `warm 2m`, then `warm <1m`.
      const warm = isWorking ? 'warm' : leftMs <= MINUTE ? 'warm <1m' : `warm ${Math.ceil(leftMs / MINUTE)}m`
      const cache = snap.respondedAt === null ? 'waiting' : isWarm ? warm : 'cold'
      // A reply restarts the lifetime, so it sends again even when the text is the same: the TTL needs the refresh.
      const cacheKey = isWarm ? `${cache}@${snap.respondedAt}` : cache
      if (cacheKey !== sentCache) {
        sentCache = cacheKey
        send(`cache=${cache}`, isWarm ? Math.ceil(leftMs) : undefined)
      }
      // Apart from the cache token: --ttl-ms covers every token of a call.
      const pct = String(Math.round(ctx * 100))
      if (pct !== sentCtx) {
        sentCtx = pct
        send(`ctx=${pct}`, CTX_TTL_MS)
      }
    },
  }
}
