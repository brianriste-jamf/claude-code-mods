import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, Register } from 'claude-code'

import type { Snapshot } from '../types'
import {
  bar,
  calibrate,
  countdown,
  gaugeState,
  isSameModel,
  level,
  nextCost,
  ratesFor,
  tokens,
  ttlMs,
  usd,
  weightedUnits,
} from './pricing'
import type { Ttl } from './pricing'
import { createHerdr } from './herdr'

const PLUGIN = 'cache-gauge'
const snapshot = atom({ plugin: 'cache-gauge', key: 'snapshot' } as const, null)
const isHidden = atom({ plugin: 'cache-gauge', key: 'isHidden' } as const, false)
const now = atom({ plugin: 'cache-gauge', key: 'now' } as const, 0)

type Herdr = ReturnType<typeof createHerdr>

// `t` is the time the caller already holds; without it the clock is read.
async function sync($: EngineInterface, herdr: Herdr, t?: number) {
  if (herdr.isOn) {
    herdr.report(await read($, snapshot), t ?? (await $.clock.now()))
  }
}

const onAbovePrompt = (on: On, ttl: Ttl) => {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    if (e.props.hasSurvey || snap === null || (await read($, isHidden))) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)

    const { limit, ctx, leftMs, isWarm } = gaugeState(snap, ttl, await read($, now))
    const ctxPart = ` · ctx ${tokens(snap.ctxTokens)}/${tokens(limit)} `

    let state
    let consequence
    if (snap.respondedAt === null) {
      state = <Text dimColor>◌ waiting for a reply</Text>
      consequence = ''
    } else {
      const current = snap.currentModel ?? snap.model
      const cost = nextCost(snap.ctxTokens, snap.baseUsd, current, ttl)
      const price = (n: number) => `${snap.isCalibrated ? '' : '~'}${usd(n)}`
      const cold = price(cost.cold)
      state = isWarm ? (
        // Mid-turn every request restarts the lifetime: count down only once idle.
        e.props.isWorking ? (
          <Text color="success">● warm</Text>
        ) : (
          <Text color={leftMs < ttlMs(ttl) * 0.2 ? 'warning' : 'success'}>{`● warm ${countdown(leftMs)}`}</Text>
        )
      ) : (
        <Text color="error">○ cold</Text>
      )
      consequence = isWarm ? ` · next msg ${price(cost.warm)} (cold ${cold})` : ` · next msg ${cold}`
    }

    const mine = (
      <Box>
        {state}
        <Text dimColor>{`${consequence}${ctxPart}`}</Text>
        <Text color={level(ctx, 0.5, 0.8)}>{bar(ctx)}</Text>
        <Text dimColor>{` ${Math.round(ctx * 100)}%`}</Text>
      </Box>
    )
    // Wrap, not replace: another mod's line (cache-keepalive) stays in the band.
    const below = await next(e)

    return below ? (
      <Box flexDirection="column">
        {mine}
        {below}
      </Box>
    ) : (
      mine
    )
  })
}

const onPromptHint = (on: On, ttl: Ttl) => {
  // Dim tail on the hint line under the prompt: cache state and context fill only.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    if (snap === null || (await read($, isHidden))) {
      return next(e)
    }

    const { limit, ctx, leftMs, isWarm } = gaugeState(snap, ttl, await read($, now))
    let state = '◌ waiting'
    if (snap.respondedAt !== null) {
      // Mid-turn every request restarts the lifetime: count down only once idle.
      state = isWarm ? (e.props.isWorking ? '● warm' : `● warm ${countdown(leftMs)}`) : '○ cold'
    }
    const mine = `${state} · ctx ${tokens(snap.ctxTokens)}/${tokens(limit)} ${Math.round(ctx * 100)}%`
    const tail = e.props.tail ? `${e.props.tail} · ${mine}` : `  ${mine}`

    return next({ ...e, props: { ...e.props, tail } })
  })
}

export const register: Register = (on, options) => {
  const ttl: Ttl = options.cacheTtl === '1h' ? '1h' : '5m'
  const position = options.position === 'above' ? 'above' : 'hint'
  let lastUsd = 0
  // Calibrated per model: a /model switch must not price one model at another's rate.
  const bases = new Map<string, number>()
  const baseFor = (model: string) => [...bases].find(([m]) => isSameModel(m, model))?.[1] ?? null
  let sawSubagent = false
  let warmUntil = 0
  let drawnAt = 0
  const herdr = createHerdr(ttl)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: PLUGIN, description: 'Show or hide the cache gauge' })
    const usage = await $.session.usage({ breakdown: 'summary' })
    lastUsd = usage.cost?.usd ?? 0
    // Draw the context at once (a reload, a resumed session) rather than after the
    // next reply; the cache's state is unknown until a reply says when it was written.
    const held = await read($, snapshot)
    if (held === null && usage.context.tokens !== undefined) {
      const breakdown = usage.context.breakdown
      const model = breakdown?.model ?? ''
      await update($, snapshot, () => ({
        ctxTokens: usage.context.tokens ?? 0,
        window: usage.context.window,
        compactAt: breakdown?.isAutoCompactEnabled ? (breakdown.autoCompactThreshold ?? null) : null,
        respondedAt: null,
        isCompacted: false,
        model,
        currentModel: model,
        baseUsd: ratesFor(model).input,
        isCalibrated: false,
      }))
    }
    // A reload starts the module over: pick the countdown up from the held reply.
    if (held !== null && held.respondedAt !== null && !held.isCompacted) {
      warmUntil = held.respondedAt + ttlMs(ttl)
    }
    await herdr.detect(argv => $.process.run(argv))
    // A fresh or reloaded session may hold no model in its usage yet; the session knows it.
    if (herdr.isOn) {
      const model = await $.session.model().catch(() => null)
      if (typeof model === 'string') {
        herdr.showModel(model)
      }
    }
    await sync($, herdr)
    // Ticks until the band has drawn the cache cold. Not a time window: a machine
    // that sleeps through the expiry wakes to a first tick long past it.
    $.clock.every(1000, () => {
      if (drawnAt > warmUntil) {
        return
      }
      void $.clock.now().then(async t => {
        drawnAt = t
        await update($, now, () => t)
        await sync($, herdr, t)
      })
    })

    return next(e)
  })

  on('command.run', { command: PLUGIN }, async ($, e) => {
    if (e.args.trim() === 'debug') {
      const u = await $.session.usage({ breakdown: 'summary' })
      const b = u.context.breakdown
      const raw = {
        context: { tokens: u.context.tokens, window: u.context.window, percent: u.context.percent },
        breakdown: b && {
          totalTokens: b.totalTokens,
          rawMaxTokens: b.rawMaxTokens,
          autocompactSource: b.autocompactSource,
          percentage: b.percentage,
          autoCompactThreshold: b.autoCompactThreshold,
          isAutoCompactEnabled: b.isAutoCompactEnabled,
          model: b.model,
          categories: b.categories.map(c => `${c.kind}:${c.name}=${c.tokens}`),
        },
        snapshot: await read($, snapshot),
      }

      return { text: JSON.stringify(raw, null, 2) }
    }
    const arg = e.args.trim().toLowerCase()
    const hidden = await update($, isHidden, was => (arg === 'show' ? false : arg === 'hide' ? true : !was))

    return { text: hidden ? 'Cache gauges hidden.' : 'Cache gauges shown.' }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) {
      sawSubagent = true

      return result
    }
    herdr.setWorking(false)
    if (!e.usage) {
      return result
    }

    const usage = await $.session.usage({ breakdown: 'summary' })
    const sessionUsd = usage.cost?.usd ?? lastUsd
    // A subagent's cost is in Δcost but not in e.usage, so that sample would overprice.
    const model = e.usage.model
    const sample = sawSubagent ? null : calibrate(baseFor(model), sessionUsd - lastUsd, weightedUnits(e.usage, model, ttl))
    if (sample !== null) {
      bases.set(model, sample)
    }
    const baseUsd = baseFor(model)
    lastUsd = sessionUsd
    sawSubagent = false

    const respondedAt = await $.clock.now()
    warmUntil = respondedAt + ttlMs(ttl)
    const breakdown = usage.context.breakdown
    const fresh: Snapshot = {
      ctxTokens: usage.context.tokens ?? 0,
      window: usage.context.window,
      compactAt: breakdown?.isAutoCompactEnabled ? (breakdown.autoCompactThreshold ?? null) : null,
      respondedAt,
      isCompacted: false,
      model,
      currentModel: model,
      baseUsd: baseUsd ?? ratesFor(model).input,
      isCalibrated: baseUsd !== null,
    }
    await update($, snapshot, () => fresh)
    drawnAt = respondedAt
    await update($, now, () => respondedAt)
    await sync($, herdr, respondedAt)

    return result
  })

  // Every main-loop request reads the cache and restarts its lifetime, so a long
  // turn of tool calls keeps it warm; the turn's end alone would draw it cold.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId !== undefined || result.usage === null) {
      return result
    }
    herdr.setWorking(true)
    const held = await read($, snapshot)
    if (held !== null) {
      const usage = await $.session.usage({ breakdown: 'summary' })
      const respondedAt = await $.clock.now()
      warmUntil = respondedAt + ttlMs(ttl)
      const model = result.usage.model
      const base = baseFor(model)
      await update($, snapshot, () => ({
        ...held,
        ctxTokens: usage.context.tokens ?? held.ctxTokens,
        respondedAt,
        isCompacted: false,
        model,
        currentModel: model,
        baseUsd: base ?? ratesFor(model).input,
        isCalibrated: base !== null,
      }))
      drawnAt = respondedAt
      await update($, now, () => respondedAt)
      await sync($, herdr, respondedAt)
    }

    return result
  })

  // Tokens outlive the session in herdr's sidebar until removed.
  on('session.end', async ($, e, next) => {
    await herdr.clear()

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.trigger === 'precompute' || e.agentId !== undefined || result.skip !== undefined) {
      return result
    }
    const held = await read($, snapshot)
    const usage = await $.session.usage({ breakdown: 'summary' })
    // The summarizer's cost is in the session total but in no reply's tokens.
    lastUsd = usage.cost?.usd ?? lastUsd
    if (held !== null) {
      // The compacted conversation is a new prefix: nothing of it is cached yet.
      warmUntil = 0
      await update($, snapshot, () => ({
        ...held,
        ctxTokens: result.tokensAfter ?? usage.context.tokens ?? held.ctxTokens,
        isCompacted: true,
      }))
      await sync($, herdr)
    }

    return result
  })

  // `/model` (and `/fast`, when it promotes the model) points the next message at
  // another model: its own price, and none of the context in its cache.
  on('command.run', async ($, e, next) => {
    const result = await next(e)
    if (e.command !== 'model' && e.command !== 'fast') {
      return result
    }
    const held = await read($, snapshot)
    const current = await $.session.model()
    if (held !== null && typeof current === 'string' && !isSameModel(current, held.currentModel ?? held.model)) {
      const base = baseFor(current)
      await update($, snapshot, () => ({
        ...held,
        currentModel: current,
        baseUsd: base ?? ratesFor(current).input,
        isCalibrated: base !== null,
      }))
      await sync($, herdr)
    }

    return result
  })

  if (position === 'above') {
    onAbovePrompt(on, ttl)
  } else {
    onPromptHint(on, ttl)
  }
}
