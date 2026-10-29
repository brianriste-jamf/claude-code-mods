import type { Snapshot } from '../types'
import { gaugeState } from './pricing'
import type { Ttl } from './pricing'

// herdr's longest token lifetime: a crashed session's ctx is gone by then.
const CTX_TTL_MS = 86_400_000
const STEP_MS = 30_000
// Backstop for the `compacting` and `working` tokens, in case the session dies mid-way.
const HOLD_TTL_MS = 600_000

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
  let focusCmd = ''
  let sentCache: string | null = null
  let sentCtx: string | null = null
  let isWorking = false
  let isCompacting = false
  let isAgents = false
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

    /** A shell command that focuses this session's agent, usable from a bare environment; empty when it can't be built. */
    get focusCommand() {
      return focusCmd
    },

    /** herdr sets HERDR_PANE_ID in the pane's environment; a child process inherits it. */
    async detect(runner: Run) {
      run = runner
      try {
        paneId = (await run(['sh', '-c', 'printf %s "$HERDR_PANE_ID"'])).stdout.trim()
      } catch {
        paneId = ''
      }
      focusCmd = ''
      if (paneId !== '') {
        // A notification click runs in a bare environment: herdr needs its full path and its socket.
        try {
          const [sock, bin] = (await run(['sh', '-c', 'printf "%s\\n%s" "$HERDR_SOCKET_PATH" "$(command -v herdr)"'])).stdout.split('\n')
          const quote = (v: string) => `'${v.replaceAll("'", "'\\''")}'`
          if (sock && bin?.startsWith('/')) {
            focusCmd = `HERDR_SOCKET_PATH=${quote(sock)} ${quote(bin)} agent focus ${quote(paneId)}`
          }
        } catch {
          focusCmd = ''
        }
      }
    },

    /** Mid-turn every request restarts the lifetime, so the cache token drops its countdown. */
    setWorking(value: boolean) {
      isWorking = value
    },

    /** While a compaction runs the cache token reads `compacting`. */
    setCompacting(value: boolean) {
      isCompacting = value
    },

    /** While a subagent works the cache token reads `working`. */
    setAgents(value: boolean) {
      isAgents = value
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
    report(snap: Snapshot | null, t: number, pingedAt = 0) {
      if (paneId === '' || snap === null) {
        return
      }
      const { ctx, leftMs, isWarm } = gaugeState(snap, getTtl(), t, pingedAt)
      showModel(snap.currentModel ?? snap.model)
      // The countdown steps every 30 s, rounded up, in minutes: `warm 5m`, `warm 4.5m` ... `warm 0.5m`.
      const warm = isWorking ? 'warm' : `warm ${(Math.ceil(leftMs / STEP_MS) * STEP_MS) / 60_000}m`
      const hold = isCompacting ? 'compacting' : isAgents ? 'working' : null
      const cache = hold ?? (snap.respondedAt === null ? 'waiting' : isWarm ? warm : 'cold')
      // A reply restarts the lifetime, so it sends again even when the text is the same: the TTL needs the refresh.
      const isTimed = isWarm && hold === null
      const cacheKey = isTimed ? `${cache}@${Math.max(snap.respondedAt ?? 0, pingedAt)}` : cache
      if (cacheKey !== sentCache) {
        sentCache = cacheKey
        send(`cache=${cache}`, hold !== null ? HOLD_TTL_MS : isTimed ? Math.ceil(leftMs) : undefined)
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
