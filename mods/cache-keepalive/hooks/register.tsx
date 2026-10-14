import type { EngineInterface, Register } from 'claude-code'

import { clock, plan, resolveTtl } from './budget'
import type { PlanOptions, Ttl } from './budget'

const NAME = 'cache-keepalive'
const TICK_MS = 5000
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

async function step($: EngineInterface, k: Keepalive) {
  if (!k.isEnabled) {
    $.ui.status(undefined)
    return
  }

  const p = plan(k.model, k.ttl, k.options)
  const head = `keepalive[${p.ttl}] ${k.pings}/${p.limit}`
  const idle = (await $.clock.now()) - k.lastActivity

  if (k.isBusy) {
    $.ui.status(`${head} · turn running`)
    return
  }

  if (idle >= p.ttlMs) {
    $.ui.status(`${head} · cache cold`)
    return
  }

  if (k.pings >= p.limit) {
    $.ui.status(`${head} · budget used, lapses in ${clock(p.ttlMs - idle)}`)

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

  const untilNext = p.intervalMs - idle
  const left = untilNext + (p.limit - k.pings - 1) * p.intervalMs

  $.ui.status(`${head} · next ${clock(untilNext)} · ${clock(left)} left`)
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
      $.ui.status(undefined)

      return { text: 'Cache keep-alive off.' }
    }

    await refreshTtl($, k)
    const p = plan(k.model, k.ttl, k.options)

    return {
      text: `Cache keep-alive ${k.isEnabled ? 'armed' : 'off'}: model ${k.model ?? 'unknown yet'}, ${p.ttl} cache (${k.ttlSource}), ${k.pings}/${p.limit} pings this idle period, one every ${clock(p.intervalMs)}.`,
    }
  })
}
