import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { KeepaliveView } from '../types'

import { clock, describe, plan, resolveTtl } from './budget'
import type { PlanOptions, Ttl } from './budget'

const NAME = 'cache-keepalive'
const TICK_MS = 1000
const view = atom({ plugin: 'cache-keepalive', key: 'view' } as const, { kind: 'off' } as KeepaliveView)
const PING = 'Cache keep-alive ping. Reply with the single word "ok" and use no tools.'

type Keepalive = {
  options: PlanOptions
  override: unknown
  isEnabled: boolean
  isBusy: boolean
  hasWarned: boolean
  model: string | undefined
  ttl: Ttl
  ttlSource: string
  lastActivity: number
  pings: number
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

async function step($: EngineInterface, k: Keepalive) {
  if (!k.isEnabled) {
    await show($, { kind: 'off' })
    return
  }

  const p = plan(k.model, k.ttl, k.options)
  const counts = { pings: k.pings, limit: p.limit }
  const idle = (await $.clock.now()) - k.lastActivity

  if (k.isBusy) {
    await show($, { kind: 'busy', ...counts })
    return
  }

  if (idle >= p.ttlMs) {
    await show($, { kind: 'cold', ...counts })
    return
  }

  if (k.pings >= p.limit) {
    await show($, { kind: 'spent', ...counts, lapsesInMs: p.ttlMs - idle })

    if (!k.hasWarned) {
      k.hasWarned = true
      $.ui.toast(`cache-keepalive: ${p.limit} pings used, the cache will lapse`)
    }

    return
  }

  if (idle >= p.intervalMs) {
    k.pings += 1
    k.isBusy = true

    try {
      await $.prompt.submit({ text: PING })
    } catch {
      k.isBusy = false
    }

    return
  }

  const nextPingMs = p.intervalMs - idle
  // The last ping still leaves the cache warm for a full lifetime after it.
  const warmForMs = nextPingMs + (p.limit - k.pings - 1) * p.intervalMs + p.ttlMs

  await show($, { kind: 'waiting', ...counts, nextPingMs, warmForMs })
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
    isBusy: false,
    hasWarned: false,
    model: undefined,
    ttl: '5m',
    ttlSource: 'default (assumed)',
    lastActivity: 0,
    pings: 0,
  }

  on('session.start', async ($, e, next) => {
    k.lastActivity = await $.clock.now()
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

    $.clock.every(TICK_MS, () => void step($, k))

    return next(e)
  })

  on('turn.start', ($, e, next) => {
    k.isBusy = true

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // A subagent's turn says nothing about the main conversation's cache.
    if (e.agentId === undefined) {
      k.isBusy = false
      k.lastActivity = await $.clock.now()
      k.model = e.usage?.model ?? k.model
    }

    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    const isOwnPing = e.origin.kind === 'plugin' && e.origin.name === NAME

    if (!isOwnPing) {
      k.pings = 0
      k.hasWarned = false
    }

    return next(e)
  })

  on('command.run', { command: NAME }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === 'on') {
      await refreshTtl($, k)
      k.isEnabled = true
      k.pings = 0
      k.hasWarned = false
      await step($, k)

      const p = plan(k.model, k.ttl, k.options)

      return {
        text: `Cache keep-alive armed: ${p.ttl} cache (${k.ttlSource}), up to ${p.limit} pings, one every ${clock(p.intervalMs)}.`,
      }
    }

    if (arg === 'off') {
      k.isEnabled = false
      await show($, { kind: 'off' })

      return { text: 'Cache keep-alive off.' }
    }

    await refreshTtl($, k)
    const p = plan(k.model, k.ttl, k.options)

    return {
      text: `Cache keep-alive ${k.isEnabled ? 'armed' : 'off'}: model ${k.model ?? 'unknown yet'}, ${p.ttl} cache (${k.ttlSource}), ${k.pings}/${p.limit} pings this idle period, one every ${clock(p.intervalMs)}.`,
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
