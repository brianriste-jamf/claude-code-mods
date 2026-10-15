import type { Snapshot } from '../types'
import { gaugeState } from './pricing'
import type { Ttl } from './pricing'

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
  // One call at a time, so a quick warm then cold lands in order.
  let queue: Promise<unknown> = Promise.resolve()

  const send = (token: string, ttlMs?: number) => {
    const argv = ['herdr', 'pane', 'report-metadata', paneId, '--source', 'cache-gauge', '--token', token]
    // herdr deletes an expired token, so a warm token carries its lifetime as a backstop.
    queue = queue.then(() => run(ttlMs === undefined ? argv : [...argv, '--ttl-ms', String(ttlMs)])).catch(() => {})
  }

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

    /** Sends what changed since the last report. */
    report(snap: Snapshot | null, t: number) {
      if (paneId === '' || snap === null) {
        return
      }
      const { ctx, leftMs, isWarm } = gaugeState(snap, ttl, t)
      const cache = snap.respondedAt === null ? 'waiting' : isWarm ? 'warm' : 'cold'
      // A new reply restarts the lifetime, so a warm token is sent again with the fresh TTL.
      const cacheKey = isWarm ? `warm@${snap.respondedAt}` : cache
      if (cacheKey !== sentCache) {
        sentCache = cacheKey
        send(`cache=${cache}`, isWarm ? Math.ceil(leftMs) : undefined)
      }
      // Apart from the cache token: --ttl-ms covers every token of a call.
      const pct = String(Math.round(ctx * 100))
      if (pct !== sentCtx) {
        sentCtx = pct
        send(`ctx=${pct}`)
      }
    },
  }
}
