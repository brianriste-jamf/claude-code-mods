import type { Snapshot } from '../types'
import { gaugeState } from './pricing'
import type { Ttl } from './pricing'

// herdr's longest token lifetime: a crashed session's ctx is gone by then.
const CTX_TTL_MS = 86_400_000
const STEP_MS = 30_000

/** `us.anthropic.claude-opus-5-5` -> `opus 5.5`; an id of another shape is returned as it is. */
export const shortModel = (id: string): string => {
  const bare = id
    .replace(/\[.*\]$/, '')
    .replace(/-v\d+(:\d+)?$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/^([a-z-]+\.)*anthropic\./, '')
    .replace(/^claude-/, '')
  const m = /^([a-z]+)-(\d+(?:-\d+)*)$/.exec(bare)

  return m ? `${m[1]} ${m[2]?.replaceAll('-', '.')}` : id
}

type Run = (argv: string[]) => Promise<{ stdout: string }>

/**
 * Reports the gauge as herdr pane metadata tokens (`cache`, `ctx`) when the session runs in a herdr pane.
 * Off outside herdr, and a herdr that is missing or fails never reaches the gauge.
 */
export const createHerdr = (getTtl: () => Ttl) => {
  let run: Run
  let paneId = ''
  let sentCache: string | null = null
  let sentCtx: string | null = null
  let isWorking = false
  let sentModel: string | null = null
  // One call at a time, so a quick warm then cold lands in order.
  let queue: Promise<unknown> = Promise.resolve()

  const call = (...args: string[]) => {
    const argv = ['herdr', 'pane', 'report-metadata', paneId, '--source', 'cache-gauge', ...args]
    queue = queue.then(() => run(argv)).catch(() => {})
  }
  // herdr deletes an expired token, so a token carries its lifetime as a backstop.
  const send = (token: string, ttlMs?: number) =>
    call('--token', token, ...(ttlMs === undefined ? [] : ['--ttl-ms', String(ttlMs)]))

  // The sidebar's agent slot reads the model; --agent keeps it to a pane that is still running claude.
  const showModel = (model: string) => {
    if (paneId !== '' && model !== '' && model !== sentModel) {
      sentModel = model
      call('--display-agent', shortModel(model), '--agent', 'claude')
    }
  }

  return {
    showModel,

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
      sentModel = null
      call('--clear-token', 'cache', '--clear-token', 'ctx', '--clear-display-agent')
      await queue
    },

    /** Sends what changed since the last report. */
    report(snap: Snapshot | null, t: number) {
      if (paneId === '' || snap === null) {
        return
      }
      const { ctx, leftMs, isWarm } = gaugeState(snap, getTtl(), t)
      showModel(snap.currentModel ?? snap.model)
      // The countdown steps every 30 s, rounded up, in minutes: `warm 5m`, `warm 4.5m` ... `warm 0.5m`.
      const warm = isWorking ? 'warm' : `warm ${(Math.ceil(leftMs / STEP_MS) * STEP_MS) / 60_000}m`
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
