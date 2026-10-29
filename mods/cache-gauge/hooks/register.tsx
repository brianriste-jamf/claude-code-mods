import { atom, read, update } from 'claude-code'
import type { Atom, EngineInterface, On, Register } from 'claude-code'

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
  resolveTtl,
  tokens,
  ttlMs,
  usd,
  weightedUnits,
} from './pricing'
import type { Ttl } from './pricing'
import { alarmMode, createAlarm } from './alarm'
import { createHerdr } from './herdr'

const PLUGIN = 'cache-gauge'
const snapshot = atom({ plugin: 'cache-gauge', key: 'snapshot' } as const, null)
// Owned by cache-keepalive: when its last successful fork ping's request started; 0 for none. Read-only here, and cast
// because this mod's types do not declare another mod's state.
const pingedAt = atom({ plugin: 'cache-keepalive', key: 'lastPingAt' } as never, 0) as unknown as Atom<number>
const isHidden = atom({ plugin: 'cache-gauge', key: 'isHidden' } as const, false)
const now = atom({ plugin: 'cache-gauge', key: 'now' } as const, 0)
// True while a main-conversation compaction runs; flipping it is what redraws the line, since the tick stops once it has drawn cold.
const isCompacting = atom({ plugin: 'cache-gauge', key: 'isCompacting' } as const, false)
// True while a subagent works: the main cache is then not counting down for the user to act on.
const isAgentsBusy = atom({ plugin: 'cache-gauge', key: 'isAgentsBusy' } as const, false)
// A subagent with no step for this long no longer counts (one that died without a turn.complete).
const AGENT_STALE_MS = 600_000

type Herdr = ReturnType<typeof createHerdr>

// Re-read where Claude Code takes the cache lifetime from; the mod option overrides it when set to 5m or 1h ('auto' defers).
async function resolveFrom($: EngineInterface, override: unknown): Promise<Ttl> {
  const settings: Record<string, unknown> = await $.settings.read()

  return resolveTtl({
    override,
    force5m: await $.env.get('FORCE_PROMPT_CACHING_5M'),
    env: await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
    setting: settings.promptCacheTtl,
    enable1h: await $.env.get('ENABLE_PROMPT_CACHING_1H'),
  })
}

// `t` is the time the caller already holds; without it the clock is read.
async function sync($: EngineInterface, herdr: Herdr, t?: number) {
  if (herdr.isOn) {
    herdr.report(await read($, snapshot), t ?? (await $.clock.now()), await read($, pingedAt))
  }
}

const onAbovePrompt = (on: On, getTtl: () => Ttl) => {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    if (e.props.hasSurvey || snap === null || (await read($, isHidden))) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)

    const ttl = getTtl()
    const { limit, ctx, leftMs, isWarm } = gaugeState(snap, ttl, await read($, now), await read($, pingedAt))
    const ctxPart = ` · ctx ${tokens(snap.ctxTokens)}/${tokens(limit)} `

    let state
    let consequence
    const busy = (await read($, isCompacting)) ? '◌ compacting' : (await read($, isAgentsBusy)) ? '◌ agent working' : null
    if (busy !== null) {
      state = <Text dimColor>{busy}</Text>
      consequence = ''
    } else if (snap.respondedAt === null) {
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

const onPromptHint = (on: On, getTtl: () => Ttl, isColored: boolean) => {
  // Dim tail on the hint line under the prompt: cache state and context fill only.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    if (snap === null || (await read($, isHidden))) {
      return next(e)
    }

    const ttl = getTtl()
    const { limit, ctx, leftMs, isWarm } = gaugeState(snap, ttl, await read($, now), await read($, pingedAt))
    const isEnding = isWarm && leftMs <= 60_000
    const busy = (await read($, isCompacting)) ? '◌ compacting' : (await read($, isAgentsBusy)) ? '◌ agent working' : null
    let state = '◌ waiting'
    if (busy !== null) {
      state = busy
    } else if (snap.respondedAt !== null) {
      // Mid-turn every request restarts the lifetime: count down only once idle.
      if (isWarm) {
        // Uncoloured, the last minute blinks the dot once a second (the clock ticks at 1 Hz).
        const dot = !isColored && isEnding && Math.ceil(leftMs / 1000) % 2 === 0 ? '○' : '●'
        state = e.props.isWorking ? '● warm' : `${dot} warm ${countdown(leftMs)}`
      } else {
        // Only a cold cache makes the next message expensive enough to flag.
        const cost = nextCost(snap.ctxTokens, snap.baseUsd, snap.currentModel ?? snap.model, ttl)
        state = `○ cold · next msg ${snap.isCalibrated ? '' : '~'}${usd(cost.cold)}`
      }
    }
    const rest = ` · ctx ${tokens(snap.ctxTokens)}/${tokens(limit)} ${Math.round(ctx * 100)}%`

    if (!isColored) {
      const mine = `${state}${rest}`
      const tail = e.props.tail ? `${e.props.tail} · ${mine}` : `  ${mine}`

      return next({ ...e, props: { ...e.props, tail } })
    }

    // A tail is one dim string, so colour means drawing the line here instead of calling next.
    const { Box, Text } = $.ui.resolve(e)
    const color = busy !== null || snap.respondedAt === null ? undefined : !isWarm ? 'error' : isEnding && !e.props.isWorking ? 'warning' : undefined
    const lead = `${e.props.hint ?? ''}${e.props.tail ? `${e.props.tail} · ` : '  '}`

    return (
      <Box>
        <Text dimColor wrap="truncate-end">{lead}</Text>
        {color ? <Text color={color}>{state}</Text> : <Text dimColor>{state}</Text>}
        <Text dimColor wrap="truncate-end">{rest}</Text>
      </Box>
    )
  })
}

export const register: Register = (on, options) => {
  // Read at use time: `resolveFrom` re-resolves it at session start and after each turn.
  let ttl: Ttl = '5m'
  const getTtl = () => ttl
  const position = options.position === 'above' ? 'above' : 'hint'
  const isColored = options.hintColor === 'on'
  let lastUsd = 0
  // Calibrated per model: a /model switch must not price one model at another's rate.
  const bases = new Map<string, number>()
  const baseFor = (model: string) => [...bases].find(([m]) => isSameModel(m, model))?.[1] ?? null
  let sawSubagent = false
  let warmUntil = 0
  let drawnAt = 0
  const herdr = createHerdr(getTtl)
  const alarm = createAlarm(alarmMode(options.alarm), typeof options.alarmSound === 'string' ? options.alarmSound.trim() : '')
  // Set by the first model request of a turn, cleared when the turn completes.
  let isTurnActive = false
  // Mirrors the isCompacting atom for code that cannot read atoms.
  let isCompactingNow = false
  // Start time of the current turn's latest main request; null before its first.
  let stepStartedAt: number | null = null
  // Subagents mid-work: agentId -> time of their last step. Mirrors the isAgentsBusy atom in isAgentsNow.
  const activeAgents = new Map<string, number>()
  let isAgentsNow = false
  // Drops agents with no recent step; true when whether any is active changed.
  const sweepAgents = (t: number) => {
    for (const [id, at] of activeAgents) {
      if (t - at > AGENT_STALE_MS) {
        activeAgents.delete(id)
      }
    }
    const isBusy = activeAgents.size > 0
    const isChanged = isBusy !== isAgentsNow
    isAgentsNow = isBusy
    herdr.setAgents(isBusy)

    return isChanged
  }

  on('session.start', async ($, e, next) => {
    ttl = await resolveFrom($, options.cacheTtl)
    await $.command.register({ name: PLUGIN, description: 'Show or hide the cache gauge' })
    const usage = await $.session.usage({ breakdown: 'summary' })
    lastUsd = usage.cost?.usd ?? 0
    // Draw the context at once (a reload, a resumed session) rather than after the
    // next reply; the cache's state is unknown until a reply says when it was written.
    const held = await read($, snapshot)
    // Seeded even with no token count yet (a fresh session), so the gauge is there before the first message.
    if (held === null) {
      const breakdown = usage.context.breakdown
      const session = await $.session.model().catch(() => null)
      const model = breakdown?.model || (typeof session === 'string' ? session : '')
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
      void foldPing().then(() => {
        if (drawnAt > warmUntil && !isAgentsNow) {
          return
        }
        void tick()
      })
    })
    const foldPing = async () => {
      const p = await read($, pingedAt)
      const snap = p > 0 ? await read($, snapshot) : null
      if (snap !== null && snap.respondedAt !== null && !snap.isCompacted && p > snap.respondedAt && isSameModel(snap.currentModel ?? snap.model, snap.model)) {
        warmUntil = Math.max(warmUntil, p + ttlMs(ttl))
      }
    }
    const tick = () =>
      $.clock.now().then(async t => {
        drawnAt = t
        if (sweepAgents(t)) {
          await update($, isAgentsBusy, () => isAgentsNow)
        }
        await update($, now, () => t)
        await sync($, herdr, t)
        const snap = await read($, snapshot)
        const cost = snap === null ? null : nextCost(snap.ctxTokens, snap.baseUsd, snap.currentModel ?? snap.model, ttl)
        const mark = snap?.isCalibrated ? '' : '~'
        const prices = cost === null ? null : { warm: `${mark}${usd(cost.warm)}`, cold: `${mark}${usd(cost.cold)}` }
        alarm.tick(
          {
            notify: (body, isFirst) => {
              if (isFirst) {
                $.ui.toast(body, { timeoutMs: 8000 })
              }
              // $.ui.notify and herdr's toast never reached the user inside herdr; Notification Center does.
              // terminal-notifier's click returns to this agent, and its group replaces the earlier message in place;
              // without it (or if it fails) a plain banner.
              const focus = herdr.focusCommand
              const click = focus === '' ? [] : ['-activate', 'com.mitchellh.ghostty', '-execute', focus]
              const sound = isFirst ? ['-sound', 'Sosumi'] : []
              // The body goes in as an argument, never spliced into the script, so a quote in it cannot break out.
              const banner = () =>
                $.process
                  .run([
                    'osascript',
                    '-e',
                    'on run argv',
                    '-e',
                    `display notification (item 1 of argv) with title "Cache ending"${isFirst ? ' sound name "Sosumi"' : ''}`,
                    '-e',
                    'end run',
                    body,
                  ])
                  .catch(() => {})
              void $.process
                .run(['terminal-notifier', '-title', 'Cache ending', '-message', body, ...sound, '-group', 'cache-gauge', ...click])
                .then(r => (r.exitCode === 0 ? undefined : banner()))
                .catch(banner)
            },
            clear: () => {
              void $.process.run(['terminal-notifier', '-remove', 'cache-gauge']).catch(() => {})
            },
            play: (clip, signal) => $.audio.play(clip, { signal }),
            readBytes: async path => (await $.fs.read(path, { as: 'bytes' })).base64,
          },
          t,
          warmUntil,
          !isTurnActive && !isCompactingNow && !isAgentsNow,
          prices,
        )
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
      activeAgents.delete(e.agentId)
      if (sweepAgents(await $.clock.now())) {
        await update($, isAgentsBusy, () => isAgentsNow)
        await sync($, herdr)
      }

      return result
    }
    herdr.setWorking(false)
    isTurnActive = false
    if (!e.usage) {
      return result
    }
    ttl = await resolveFrom($, options.cacheTtl)

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

    // The lifetime runs from the start of the turn's last request, which turn.step already recorded.
    const completedAt = await $.clock.now()
    const respondedAt = stepStartedAt ?? completedAt
    stepStartedAt = null
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
    drawnAt = completedAt
    await update($, now, () => completedAt)
    await sync($, herdr, completedAt)

    return result
  })

  // The turn is active from its start, not from its first response: the request in flight has already refreshed the cache.
  // The countdown is untouched here: a turn aborted before any request sent nothing.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      isTurnActive = true
      // A step start left over from an earlier turn must not anchor this one if it sends no request.
      stepStartedAt = null
      alarm.reset()
    }

    return next(e)
  })

  // Every main-loop request reads the cache and restarts its lifetime, so a long
  // turn of tool calls keeps it warm; the turn's end alone would draw it cold.
  on('turn.step', async function* ($, e, next) {
    // A subagent's request leaves the main cache alone, but while it works the user has nothing to act on.
    if (e.agentId !== undefined) {
      const t = await $.clock.now()
      sweepAgents(t)
      if (activeAgents.size === 0) {
        alarm.reset()
      }
      activeAgents.set(e.agentId, t)
      if (sweepAgents(t)) {
        await update($, isAgentsBusy, () => true)
        await sync($, herdr, t)
      }
    }
    // The API measures the lifetime from the start of the request, so a long response counts against it.
    const isMain = e.agentId === undefined
    if (isMain) {
      const startedAt = await $.clock.now()
      stepStartedAt = startedAt
      warmUntil = startedAt + ttlMs(ttl)
      herdr.setWorking(true)
      isTurnActive = true
      alarm.reset()
      const held = await read($, snapshot)
      if (held !== null) {
        // Holds the start of the last request, not the end of the response.
        await update($, snapshot, () => ({ ...held, respondedAt: startedAt, isCompacted: false }))
      }
      drawnAt = startedAt
      await update($, now, () => startedAt)
      await sync($, herdr, startedAt)
    }
    const result = yield* next(e)
    if (e.agentId !== undefined) {
      activeAgents.set(e.agentId, await $.clock.now())

      return result
    }
    if (result.usage === null) {
      return result
    }
    const held = await read($, snapshot)
    if (held !== null) {
      const usage = await $.session.usage({ breakdown: 'summary' })
      const model = result.usage.model
      const base = baseFor(model)
      await update($, snapshot, () => ({
        ...held,
        ctxTokens: usage.context.tokens ?? held.ctxTokens,
        model,
        currentModel: model,
        baseUsd: base ?? ratesFor(model).input,
        isCalibrated: base !== null,
      }))
      await sync($, herdr)
    }

    return result
  })

  // The clip stops at the keystroke that sends a message, not at the reply's first request.
  on('prompt.submit', async ($, e, next) => {
    alarm.reset()

    return next(e)
  })

  // Tokens outlive the session in herdr's sidebar until removed.
  on('session.end', async ($, e, next) => {
    alarm.reset()
    await herdr.clear()

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    if (e.trigger === 'precompute' || e.agentId !== undefined) {
      return next(e)
    }
    // A compaction can run for minutes: show it, keep the alarm quiet and take down its notification.
    isCompactingNow = true
    herdr.setCompacting(true)
    await update($, isCompacting, () => true)
    alarm.reset()
    await sync($, herdr)
    try {
      const result = await next(e)
      if (result.skip !== undefined) {
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
    } finally {
      isCompactingNow = false
      herdr.setCompacting(false)
      await update($, isCompacting, () => false)
      await sync($, herdr)
    }
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
    onAbovePrompt(on, getTtl)
  } else {
    onPromptHint(on, getTtl, isColored)
  }
}
