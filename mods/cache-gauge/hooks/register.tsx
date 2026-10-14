import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Snapshot } from '../types'
import {
  bar,
  calibrate,
  countdown,
  level,
  nextCost,
  ratesFor,
  tokens,
  ttlMs,
  usd,
  weightedUnits,
} from './pricing'
import type { Ttl } from './pricing'

const PLUGIN = 'cache-gauge'
const snapshot = atom({ plugin: 'cache-gauge', key: 'snapshot' } as const, null)
const isHidden = atom({ plugin: 'cache-gauge', key: 'isHidden' } as const, false)
const now = atom({ plugin: 'cache-gauge', key: 'now' } as const, 0)

export const register: Register = (on, options) => {
  const ttl: Ttl = options.cacheTtl === '1h' ? '1h' : '5m'
  let lastUsd = 0
  let baseUsd: number | null = null
  let sawSubagent = false
  let warmUntil = 0
  let drawnAt = 0

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: PLUGIN, description: 'Show or hide the cache gauges above the prompt' })
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
        baseUsd: ratesFor(model).input,
        isCalibrated: false,
      }))
    }
    // Ticks until the band has drawn the cache cold. Not a time window: a machine
    // that sleeps through the expiry wakes to a first tick long past it.
    $.clock.every(1000, () => {
      if (drawnAt > warmUntil) {
        return
      }
      void $.clock.now().then(t => {
        drawnAt = t

        return update($, now, () => t)
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
    if (!e.usage) {
      return result
    }

    const usage = await $.session.usage({ breakdown: 'summary' })
    const sessionUsd = usage.cost?.usd ?? lastUsd
    // A subagent's cost is in Δcost but not in e.usage, so that sample would overprice.
    if (!sawSubagent) {
      baseUsd = calibrate(baseUsd, sessionUsd - lastUsd, weightedUnits(e.usage, e.usage.model, ttl))
    }
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
      model: e.usage.model,
      baseUsd: baseUsd ?? ratesFor(e.usage.model).input,
      isCalibrated: baseUsd !== null,
    }
    await update($, snapshot, () => fresh)
    drawnAt = respondedAt
    await update($, now, () => respondedAt)

    return result
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
    }

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    if (e.props.hasSurvey || snap === null || (await read($, isHidden))) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)

    // Fill toward where compaction runs (/autocompact moves it), else the model's window.
    const limit = snap.compactAt ?? snap.window
    const ctx = limit > 0 ? snap.ctxTokens / limit : 0
    const ctxPart = ` · ctx ${tokens(snap.ctxTokens)}/${tokens(limit)} `

    let state
    let consequence
    if (snap.respondedAt === null) {
      state = <Text dimColor>◌ waiting for a reply</Text>
      consequence = ''
    } else {
      const t = Math.max(await read($, now), snap.respondedAt)
      const leftMs = snap.respondedAt + ttlMs(ttl) - t
      const isWarm = !snap.isCompacted && leftMs > 0
      const cost = nextCost(snap.ctxTokens, snap.baseUsd, snap.model, ttl)
      const price = (n: number) => `${snap.isCalibrated ? '' : '~'}${usd(n)}`
      const cold = price(cost.cold)
      state = isWarm ? (
        <Text color={leftMs < ttlMs(ttl) * 0.2 ? 'warning' : 'success'}>{`● warm ${countdown(leftMs)}`}</Text>
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
