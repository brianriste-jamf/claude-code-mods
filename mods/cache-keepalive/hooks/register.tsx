import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { KeepaliveView } from '../types'

import { clock, describe, money, plan, resolveTtl } from './budget'
import type { PlanOptions, Ttl } from './budget'

const NAME = 'cache-keepalive'
const TICK_MS = 1000
const view = atom({ plugin: 'cache-keepalive', key: 'view' } as const, { kind: 'off' } as KeepaliveView)
// Survives a reload, which starts the module over: idle time counts from the cache's last use
// (the start of a reply's last request, or of a ping), not the reload.
const lastReply = atom({ plugin: 'cache-keepalive', key: 'lastReply' } as const, 0)
// When the last successful ping's request started (0 for none); cache-gauge reads it.
const lastPingAt = atom({ plugin: 'cache-keepalive', key: 'lastPingAt' } as const, 0)
const PING = 'Cache keep-alive ping. Reply with the single word "ok" and use no tools.'
// How long to wait before trying again after an API error (429, 529, a dropped connection).
const RETRY_MS = 30_000
// A main turn silent this long is treated as dead (an error or a reload mid-turn never sent `turn.complete`).
// Mirrors AGENT_STALE_MS in cache-gauge.
const BUSY_STALE_MS = 600_000

type Keepalive = {
  options: PlanOptions
  override: unknown
  isEnabled: boolean
  /** When the main loop last started a turn or a request (0 for idle); a turn that never completes goes stale. */
  busySeenAt: number
  /** The clock at the latest tick: `turn.start` has no clock access of its own. */
  tickAt: number
  /** Main-loop tool calls in flight. */
  toolsRunning: number
  /** Orders the steps that draw the band: the ticket of the latest step and of the latest to draw. */
  ticket: number
  drawn: number
  /** A fork is in flight; the tick must not send a second one. */
  isPinging: boolean
  /** The idle period the in-flight fork belongs to. */
  pingPeriod: number
  /** A ping found the cache already gone, or there was no conversation to fork yet. */
  hasLapsed: boolean
  hasWarned: boolean
  model: string | undefined
  ttl: Ttl
  ttlSource: string
  /** When the cache was last used: the start of the main thread's last request or of the last ping that read it. */
  lastActivity: number
  /** Start of the main thread's latest request in the current turn. */
  lastRequestAt: number | undefined
  /** No ping before this, after an API error. */
  retryAt: number
  /** Counts idle periods, so a ping that returns after a message of your own is dropped. */
  period: number
  pings: number
  notifyEvery: number
  /** What this idle period's pings have cost, from the session total. */
  spentUsd: number
}

const number = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

// Re-read where Claude Code takes the cache lifetime from, so a changed setting is picked up.
async function refreshTtl($: EngineInterface, k: Keepalive) {
  const settings: Record<string, unknown> = await $.settings.read()
  const resolved = resolveTtl({
    override: k.override,
    force5m: await $.env.get('FORCE_PROMPT_CACHING_5M'),
    env: await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
    setting: settings.promptCacheTtl,
    enable1h: await $.env.get('ENABLE_PROMPT_CACHING_1H'),
  })

  k.ttl = resolved.ttl
  k.ttlSource = resolved.source
}

// A tick redraws the band only when what it shows changed.
async function show($: EngineInterface, next: KeepaliveView) {
  const was = await read($, view)
  if (JSON.stringify(was) !== JSON.stringify(next)) {
    await update($, view, () => next)
  }
}

async function sessionUsd($: EngineInterface): Promise<number | null> {
  try {
    return (await $.session.usage({ breakdown: 'summary' })).cost?.usd ?? null
  } catch {
    return null
  }
}

// A native notification, so the person away from the terminal sees what idling costs.
async function notify($: EngineInterface, k: Keepalive, text: string) {
  if (k.notifyEvery <= 0) {
    return
  }
  try {
    await $.ui.notify(text, { title: 'Cache keep-alive' })
  } catch {
    // A Notification hook denied it, or the write failed: the band still shows it.
  }
}

// A fork read the prefix from cache only if the cache served most of it; near zero, the entry had lapsed.
const isCacheHit = (u: ModelUsage) => u.cache_read_input_tokens > 0 && u.cache_read_input_tokens >= u.input_tokens + u.cache_creation_input_tokens

// One ping: a fork over the main thread's last request reads its prefix from cache, which
// restarts the cache's lifetime, and adds nothing to the transcript. A ping turn would stay
// in the conversation for good, and with it every later request.
async function ping($: EngineInterface, k: Keepalive) {
  // Set before the first await: the next tick must not start a second fork.
  k.isPinging = true
  k.pings += 1
  const period = k.period
  k.pingPeriod = period

  try {
    const fromUsd = await sessionUsd($)
    const startedAt = await $.clock.now()
    const r = await $.model.fork({ prompt: PING })
    if (k.period !== period) {
      return
    }
    const toUsd = await sessionUsd($)
    if (fromUsd !== null && toUsd !== null && toUsd > fromUsd) {
      k.spentUsd += toUsd - fromUsd
    }

    if (!r.isAnswered && (r.reason === 'api-error' || r.reason === 'aborted')) {
      k.pings -= 1
      k.retryAt = (await $.clock.now()) + RETRY_MS
    } else if (!('usage' in r) || !isCacheHit(r.usage)) {
      // Nothing cached to keep warm (nothing to fork yet, or the entry had lapsed):
      // wait for the next reply instead of paying for the prefix again.
      k.hasLapsed = true
    } else {
      k.lastActivity = startedAt
      await update($, lastReply, () => k.lastActivity)
      await update($, lastPingAt, () => startedAt)
      await settlePing($, k)
    }
  } catch {
    // The engine refused to send it: try again later rather than on every tick.
    k.pings -= 1
    k.retryAt = (await $.clock.now()) + RETRY_MS
  } finally {
    k.isPinging = false
  }
}

// After a ping: say every `notifyEvery` pings what idling has cost.
async function settlePing($: EngineInterface, k: Keepalive) {
  if (k.notifyEvery <= 0 || k.pings % k.notifyEvery !== 0) {
    return
  }
  const p = plan(k.model, k.ttl, k.options)
  const left = p.limit - k.pings
  const tail =
    left > 0
      ? `keeps the cache warm ~${clock(left * p.intervalMs + p.ttlMs)} more`
      : `that was the last, the cache lapses in ${clock(p.ttlMs)}`
  await notify(
    $,
    k,
    `Idle: ping ${k.pings}/${p.limit}, ${money(k.spentUsd)} spent with nobody working; ${tail}. Reply, or /cache-keepalive off.`,
  )
}

async function step($: EngineInterface, k: Keepalive) {
  // Ticks overlap while a ping is out; a step that began earlier must not redraw over a later one.
  const ticket = ++k.ticket
  const draw = (next: KeepaliveView) => {
    if (ticket < k.drawn) {
      return Promise.resolve()
    }
    k.drawn = ticket

    return show($, next)
  }
  const now = await $.clock.now()
  k.tickAt = now

  if (!k.isEnabled) {
    await draw({ kind: 'off' })
    return
  }

  const p = plan(k.model, k.ttl, k.options)
  const counts = { pings: k.pings, limit: p.limit, spentUsd: k.spentUsd }
  const idle = now - k.lastActivity

  // A main-loop tool call can run past the stale limit and is no sign of a dead turn.
  if (k.toolsRunning > 0) {
    k.busySeenAt = now
  }

  if (k.busySeenAt > 0 && now - k.busySeenAt < BUSY_STALE_MS) {
    await draw({ kind: 'busy', ...counts })
    return
  }
  k.busySeenAt = 0

  if (k.hasLapsed || idle >= p.ttlMs) {
    await draw({ kind: 'cold', ...counts })
    return
  }

  // Only the fork of this idle period shows; one from an earlier period is dropped when it returns.
  // `ping()` counts a ping before it finishes, so the view shows the completed ones.
  if (k.isPinging && k.pingPeriod === k.period) {
    await draw({ kind: 'pinging', ...counts, pings: k.pings - 1 })
    return
  }

  if (k.pings >= p.limit) {
    await draw({ kind: 'spent', ...counts, lapsesInMs: p.ttlMs - idle })

    if (!k.hasWarned) {
      k.hasWarned = true
      await notify($, k, `Budget used: ${p.limit} pings cost ${money(k.spentUsd)}. The cache lapses in ${clock(p.ttlMs - idle)}.`)
    }

    return
  }

  if (idle >= p.intervalMs && now >= k.retryAt && !k.isPinging) {
    await ping($, k)
    return
  }

  const nextPingMs = Math.max(p.intervalMs - idle, k.retryAt - now)
  // The last ping still leaves the cache warm for a full lifetime after it.
  const warmForMs = nextPingMs + (p.limit - k.pings - 1) * p.intervalMs + p.ttlMs

  await draw({ kind: 'waiting', ...counts, nextPingMs, warmForMs })
}

export const register: Register = (on, options) => {
  const k: Keepalive = {
    options: {
      factor: number(options.budgetFactor, 1),
      hardCap: number(options.maxPings, 40),
      maxHours: number(options.maxHours, 4),
      intervalPercent: number(options.intervalPercent, 90),
    },
    override: options.ttl,
    isEnabled: options.autoStart === true,
    busySeenAt: 0,
    tickAt: 0,
    toolsRunning: 0,
    ticket: 0,
    drawn: 0,
    isPinging: false,
    pingPeriod: 0,
    hasLapsed: false,
    hasWarned: false,
    model: undefined,
    ttl: '5m',
    ttlSource: 'default (assumed)',
    lastActivity: 0,
    lastRequestAt: undefined,
    retryAt: 0,
    period: 0,
    pings: 0,
    notifyEvery: Math.max(0, Math.floor(number(options.notifyEvery, 1))),
    spentUsd: 0,
  }

  on('session.start', async ($, e, next) => {
    const held = await read($, lastReply)
    k.tickAt = await $.clock.now()
    k.lastActivity = held > 0 ? held : k.tickAt
    await refreshTtl($, k)
    // Priced from the start: an unknown model falls back to the 0.1x read price,
    // which shrinks Opus 5.5's break-even budget from 24 pings to 11.
    try {
      k.model = (await $.session.usage({ breakdown: 'summary' })).context.breakdown?.model ?? k.model
    } catch {
      // Left unknown until the first reply names it.
    }

    await $.command.register({
      name: NAME,
      description: 'Keep the prompt cache warm while idle: /cache-keepalive on | off | status',
    })

    // A tick that fails (the session is going away) is retried by the next one.
    $.clock.every(TICK_MS, () => void step($, k).catch(() => undefined))

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    // Only the main loop's turn ends with a `turn.complete` that clears this; a subagent starting
    // after the main turn ended would otherwise leave the keep-alive waiting for a turn that never ends.
    if (e.agentId === undefined) {
      k.busySeenAt = k.tickAt
    }

    try {
      return await next(e)
    } catch (error) {
      // A turn that was refused never completes.
      if (e.agentId === undefined) {
        k.busySeenAt = 0
      }
      throw error
    }
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next(e)
    }

    k.toolsRunning += 1
    k.busySeenAt = k.tickAt
    try {
      return await next(e)
    } finally {
      k.toolsRunning -= 1
      k.busySeenAt = k.tickAt
    }
  })

  // The API measures the cache's lifetime from the start of the request, so a long response counts against it.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      k.lastRequestAt = await $.clock.now()
      k.busySeenAt = k.lastRequestAt
    }

    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // A subagent's turn says nothing about the main conversation's cache.
    if (e.agentId === undefined) {
      k.busySeenAt = 0
      k.hasLapsed = false
      k.lastActivity = k.lastRequestAt ?? (await $.clock.now())
      k.lastRequestAt = undefined
      await update($, lastReply, () => k.lastActivity)
      k.model = e.usage?.model ?? k.model
    }

    return next(e)
  })

  // Pings are forks and submit nothing, so every prompt starts a new idle period.
  on('prompt.submit', ($, e, next) => {
    k.period += 1
    k.pings = 0
    k.spentUsd = 0
    k.hasWarned = false
    k.retryAt = 0

    return next(e)
  })

  on('command.run', { command: NAME }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === 'on') {
      await refreshTtl($, k)
      k.isEnabled = true
      k.period += 1
      k.pings = 0
      k.spentUsd = 0
      k.hasWarned = false
      k.hasLapsed = false
      k.retryAt = 0
      await step($, k)

      const p = plan(k.model, k.ttl, k.options)

      return {
        text: `Cache keep-alive armed: ${p.ttl} cache (${k.ttlSource}), up to ${p.limit} pings, one every ${clock(p.intervalMs)}.`,
      }
    }

    if (arg === 'off') {
      k.isEnabled = false
      k.drawn = ++k.ticket
      await show($, { kind: 'off' })

      return { text: 'Cache keep-alive off.' }
    }

    await refreshTtl($, k)
    const p = plan(k.model, k.ttl, k.options)

    return {
      text: `Cache keep-alive ${k.isEnabled ? 'armed' : 'off'}: model ${k.model ?? 'unknown yet'}, ${p.ttl} cache (${k.ttlSource}), ${k.pings}/${p.limit} pings this idle period (${money(k.spentUsd)}), one every ${clock(p.intervalMs)}.`,
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await read($, view)
    if (e.props.hasSurvey || v.kind === 'off') {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const line = describe(v)
    const mine = (
      <Box>
        <Text color={line.color} dimColor={line.color === undefined}>↻ </Text>
        <Text dimColor>{line.text}</Text>
      </Box>
    )
    // Wrap, not replace: another mod's line (cache-gauge) stays in the band.
    const below = await next(e)

    return below ? (
      <Box flexDirection="column">
        {below}
        {mine}
      </Box>
    ) : (
      mine
    )
  })
}
