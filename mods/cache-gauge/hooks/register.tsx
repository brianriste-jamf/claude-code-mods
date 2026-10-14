import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Snapshot } from '../types'
import {
  bar,
  calibrate,
  countdown,
  hitRatio,
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
  const maxRequestUsd = typeof options.maxRequestUsd === 'number' && options.maxRequestUsd > 0 ? options.maxRequestUsd : 0.5
  let lastUsd = 0
  let baseUsd: number | null = null
  let sawSubagent = false
  let warmUntil = 0
  let drawnAt = 0

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: PLUGIN, description: 'Show or hide the cache gauges above the prompt' })
    lastUsd = (await $.session.usage()).cost?.usd ?? 0
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
    const hidden = await update($, isHidden, was => !was)

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
      hitRatio: hitRatio(e.usage),
      respondedAt,
      model: e.usage.model,
      baseUsd: baseUsd ?? ratesFor(e.usage.model).input,
      isCalibrated: baseUsd !== null,
      sessionUsd,
    }
    await update($, snapshot, () => fresh)
    drawnAt = respondedAt
    await update($, now, () => respondedAt)

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    if (e.props.hasSurvey || snap === null || (await read($, isHidden))) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const t = Math.max(await read($, now), snap.respondedAt)
    const leftMs = snap.respondedAt + ttlMs(ttl) - t
    const isWarm = leftMs > 0

    const ctx = snap.window > 0 ? snap.ctxTokens / snap.window : 0
    const compact = snap.compactAt ? ` · compact at ${tokens(snap.compactAt)}` : ''

    const cost = nextCost(snap.ctxTokens, snap.baseUsd, snap.model, ttl)
    const estimate = isWarm ? cost.warm : cost.cold
    const pricing = snap.isCalibrated ? '' : ' · list price'

    return (
      <Box flexDirection="column">
        <Box>
          <Text>ctx   </Text>
          <Text color={level(ctx, 0.5, 0.8)}>{bar(ctx)}</Text>
          <Text dimColor>
            {`  ${tokens(snap.ctxTokens)}/${tokens(snap.window)}  ${Math.round(ctx * 100)}%${compact}`}
          </Text>
        </Box>
        <Box>
          <Text>cache </Text>
          <Text color={isWarm ? level(1 - snap.hitRatio, 0.5, 0.8) : 'error'}>{bar(snap.hitRatio)}</Text>
          <Text dimColor>
            {`  ${Math.round(snap.hitRatio * 100)}% hit · `}
            {isWarm ? `warm ${countdown(leftMs)}` : 'cold, next request re-writes it'}
          </Text>
        </Box>
        <Box>
          <Text>next  </Text>
          <Text color={level(estimate / maxRequestUsd, 0.5, 1)}>{bar(estimate / maxRequestUsd)}</Text>
          <Text dimColor>
            {`  ~${usd(estimate)}`}
            {isWarm ? ` (cold ~${usd(cost.cold)})` : ''}
            {` · session ${usd(snap.sessionUsd)}${pricing}  `}
          </Text>
          <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
        </Box>
      </Box>
    )
  })
}
