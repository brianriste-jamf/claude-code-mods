import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { shortModel } from './herdr'
import { bar, calibrate, level, nextCost, ratesFor, weightedUnits } from './pricing'

const OPUS = 'claude-opus-5-5'
const near = (actual: number | null, expected: number) =>
  expect(Math.abs((actual ?? Number.NaN) - expected) < 1e-12).toBe(true)
const TURN_USAGE = {
  input_tokens: 1000,
  output_tokens: 2000,
  cache_read_input_tokens: 50_000,
  cache_creation_input_tokens: 9000,
  model: OPUS,
}
const HINT_OPTIONS = { position: 'hint' } as const
const HINT = {
  plugin: 'cache-gauge',
  component: 'PromptHint',
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
} as const

test('rates pick the model family, most specific first', () => {
  expect(ratesFor('us.anthropic.claude-opus-5-5').read).toBe(0.05)
  expect(ratesFor('claude-fable-5-1').read).toBe(0.025)
  expect(ratesFor('claude-fable-5').read).toBe(0.1)
  near(ratesFor('claude-sonnet-5-5').input, 2e-6)
})

test('weighted units price each token kind against uncached input', () => {
  // 1000 + 0.05*50000 + 1.25*9000 + 5*2000
  expect(weightedUnits(TURN_USAGE, OPUS, '5m')).toBe(24_750)
  expect(weightedUnits(TURN_USAGE, OPUS, '1h')).toBe(31_500)
})

test('calibration starts at the first sample, then smooths, and ignores unusable ones', () => {
  near(calibrate(null, 0.1, 25_000), 4e-6)
  near(calibrate(4e-6, 0.2, 25_000), 4e-6 + 0.3 * 4e-6)
  expect(calibrate(4e-6, 0, 25_000)).toBe(4e-6)
  expect(calibrate(null, 0.1, 0)).toBeNull()
})

test('next request is a cache read when warm and a cache write when cold', () => {
  const cost = nextCost(100_000, 4e-6, OPUS, '5m')
  near(cost.warm, 0.02)
  near(cost.cold, 0.5)
})

test('bars clamp and levels switch at their thresholds', () => {
  expect(bar(0.5, 10)).toBe('█████░░░░░')
  expect(bar(2, 4)).toBe('████')
  expect(bar(-1, 4)).toBe('░░░░')
  expect(bar(0.68, 10)).toBe('██████▊░░░')
  expect(bar(0.01, 10)).toBe('▏░░░░░░░░░')
  expect(level(0.49, 0.5, 0.8)).toBe('success')
  expect(level(0.5, 0.5, 0.8)).toBe('warning')
  expect(level(0.8, 0.5, 0.8)).toBe('error')
})

// The tail the hook hands to the engine's PromptHint, captured by the terminal handler below.
let tail: string | undefined

const captureTail = (on: On) =>
  on('ui.render', (_$, e) => {
    tail = (e.props as { tail?: string }).tail

    return { type: 'Box', children: [] }
  })

// What the engine would answer beneath the mod.
const answerUsage = (on: On, cost: { usd: number }) => {
  const clock = mock.clock(on)
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 60_000, window: 200_000, percent: 30 },
      rateLimits: [],
      cost: { ...cost },
    },
  }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  captureTail(on)

  return clock
}

// Mounts the hint with the given props and returns the tail the mod passed on (undefined when it passed none).
const hintTail = async (
  mount: (view: object) => Promise<unknown>,
  props: object = {},
  surface: 'terminal' | 'desktop' = 'terminal',
) => {
  tail = undefined
  await mount({ ...HINT, surface, props: { ...HINT.props, ...props } })

  return tail
}

test('the hint shows the gauge after a turn and goes cold past the TTL', { options: HINT_OPTIONS }, async ($, on) => {
  const cost = { usd: 0 }
  const clock = answerUsage(on, cost)
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  cost.usd = 0.099
  await $.turn.complete({
    answer: '',
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    usage: TURN_USAGE,
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await hintTail(v => $.ui.mount(v), {}, surface)).toBe('  ● warm 5:00 · ctx 60k/200k 30%')
  }

  await clock.advance(301_000)
  expect(await hintTail(v => $.ui.mount(v))).toBe('  ○ cold · ctx 60k/200k 30%')
})

test('a subagent turn keeps the hint unchanged', { options: HINT_OPTIONS }, async ($, on) => {
  const cost = { usd: 0 }
  answerUsage(on, cost)
  on('turn.complete', () => ({ text: '' }))

  const turn = { answer: '', durationMs: 1, isAborted: false, reason: 'answer', usage: TURN_USAGE } as const
  await $.turn.complete({ ...turn, turnId: 's1', agentId: 'sub' })
  expect(await hintTail(v => $.ui.mount(v))).toBeUndefined()

  cost.usd = 5
  await $.turn.complete({ ...turn, turnId: 't1' })
  expect(await hintTail(v => $.ui.mount(v))).toBe('  ● warm 5:00 · ctx 60k/200k 30%')
})

test('the command toggles the hint', { options: HINT_OPTIONS }, async ($, on) => {
  answerUsage(on, { usd: 0.099 })
  on('turn.complete', () => ({ text: '' }))
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: TURN_USAGE })

  const toggle = () =>
    $.command.run({
      command: 'cache-gauge',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 },
    })

  await toggle()
  expect(await hintTail(v => $.ui.mount(v))).toBeUndefined()

  await toggle()
  expect(await hintTail(v => $.ui.mount(v))).toBe('  ● warm 5:00 · ctx 60k/200k 30%')
})

test('the hint still goes cold when the machine slept through the TTL', { options: HINT_OPTIONS }, async ($, on) => {
  // A hand-driven clock: a sleep moves the wall clock with no tick in between.
  let t = 0
  let periods: Array<() => void> = []
  const tick = async () => {
    const due = periods
    periods = []
    due.forEach(resolve => resolve())
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  on('clock.now', () => ({ value: t }))
  on('clock.every', () => new Promise<{ value: undefined }>(resolve => periods.push(() => resolve({ value: undefined }))))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 60_000, window: 200_000, percent: 30 }, rateLimits: [], cost: { usd: 0.099 } },
  }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  captureTail(on)
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.complete({
    answer: '',
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    usage: TURN_USAGE,
  })
  t = 60_000
  await tick()

  t += 3_600_000
  await tick()

  expect(await hintTail(v => $.ui.mount(v))).toBe('  ○ cold · ctx 60k/200k 30%')
})

test('ctx is measured against the compaction threshold', { options: HINT_OPTIONS }, async ($, on) => {
  mock.clock(on)
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: {
        tokens: 238_000,
        window: 1_000_000,
        percent: 24,
        breakdown: { rawMaxTokens: 400_000, autoCompactThreshold: 367_000, isAutoCompactEnabled: true },
      },
      rateLimits: [],
      cost: { usd: 0.099 },
    },
  }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  captureTail(on)
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.complete({
    answer: '',
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    usage: TURN_USAGE,
  })

  // Measured against where compaction runs, not the model's 1M or the 400k window.
  expect(await hintTail(v => $.ui.mount(v))).toBe('  ● warm 5:00 · ctx 238k/367k 65%')
})

test('the hint draws the context at start, before any reply', { options: HINT_OPTIONS }, async ($, on) => {
  answerUsage(on, { usd: 0 })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  expect(await hintTail(v => $.ui.mount(v))).toBe('  ◌ waiting · ctx 60k/200k 30%')
})

test('show and hide set the hint, a bare command toggles it', { options: HINT_OPTIONS }, async ($, on) => {
  answerUsage(on, { usd: 0.099 })
  on('turn.complete', () => ({ text: '' }))
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: TURN_USAGE })
  const run = async (args: string) => {
    await $.command.run({
      command: 'cache-gauge',
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 },
    })

    return (await hintTail(v => $.ui.mount(v))) !== undefined
  }

  expect(await run('show')).toBe(true)
  expect(await run('show')).toBe(true)
  expect(await run('hide')).toBe(false)
  expect(await run('hide')).toBe(false)
  expect(await run('')).toBe(true)
})

test('an existing tail is preserved and the gauge appended after ` · `', { options: HINT_OPTIONS }, async ($, on) => {
  answerUsage(on, { usd: 0.099 })
  on('turn.complete', () => ({ text: '' }))
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: TURN_USAGE })

  expect(await hintTail(v => $.ui.mount(v), { tail: '↻ keepalive 3/24' })).toBe(
    '↻ keepalive 3/24 · ● warm 5:00 · ctx 60k/200k 30%',
  )
})

test('a compaction redraws the context and the cache as cold', { options: HINT_OPTIONS }, async ($, on) => {
  answerUsage(on, { usd: 0.099 })
  on('turn.complete', () => ({ text: '' }))
  const summary = [{ role: 'user', text: 'summary', toolUses: [] }] as const
  on('session.compact', () => ({ messages: summary, tokensBefore: 60_000, tokensAfter: 12_000 }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: TURN_USAGE })

  await $.session.compact({ trigger: 'manual', messages: summary })

  expect(await hintTail(v => $.ui.mount(v))).toBe('  ○ cold · ctx 12k/200k 6%')
})

test('a /model switch leaves the other model cold until switched back', { options: HINT_OPTIONS }, async ($, on) => {
  const cost = { usd: 0 }
  answerUsage(on, cost)
  on('turn.complete', () => ({ text: '' }))
  let model = OPUS
  on('session.model', () => ({ value: model }))
  on('command.run', { command: 'model' }, () => ({ text: '' }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  cost.usd = 0.099
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: TURN_USAGE })
  const switchTo = (to: string) => {
    model = to

    return $.command.run({
      command: 'model',
      args: to,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 },
    })
  }

  await switchTo('claude-sonnet-5-5')
  expect(await hintTail(v => $.ui.mount(v))).toBe('  ○ cold · ctx 60k/200k 30%')

  await switchTo(OPUS)
  expect(await hintTail(v => $.ui.mount(v))).toBe('  ● warm 5:00 · ctx 60k/200k 30%')
})

test('each request of a long turn restarts the countdown', { options: HINT_OPTIONS }, async ($, on) => {
  const clock = answerUsage(on, { usd: 0.099 })
  on('turn.complete', () => ({ text: '' }))
  const step = { turnId: 't2', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', usage: TURN_USAGE } as const
  on('turn.step', async function* () {
    return step
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: TURN_USAGE })

  await clock.advance(200_000)
  // The step streams: drain it so the hooks run to its result.
  for await (const chunk of $.turn.step({ turnId: 't2', index: 0, model: OPUS, messageCount: 3 })) {
    void chunk
  }
  await clock.advance(200_000)

  expect(await hintTail(v => $.ui.mount(v))).toBe('  ● warm 1:40 · ctx 60k/200k 30%')

  // While the turn runs the countdown would only keep resetting, so it is left out.
  expect(await hintTail(v => $.ui.mount(v), { isWorking: true })).toBe('  ● warm · ctx 60k/200k 30%')
})

const BAND = {
  plugin: 'cache-gauge',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const


const bandUsage = (on: On, cost: { usd: number }, below: object = { type: 'Box', children: [] }) => {
  const clock = mock.clock(on)
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 60_000, window: 200_000, percent: 30 },
      rateLimits: [],
      cost: { ...cost },
    },
  }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.render', () => below)

  return clock
}

test('the band shows the gauges after a turn and goes cold past the TTL', async ($, on) => {
  const cost = { usd: 0 }
  const clock = bandUsage(on, cost)
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  cost.usd = 0.099
  await $.turn.complete({
    answer: '',
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    usage: TURN_USAGE,
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: '● warm 5:00' })).toBeDefined()
    // 0.099 / 24750 = 4e-6 per token; read = 60000 * 0.05 * 4e-6, cold = 60000 * 1.25 * 4e-6
    expect(await ui.find({ type: 'Text', text: ' · next msg $0.01 (cold $0.30) · ctx 60k/200k ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' 30%' })).toBeDefined()
    await ui.unmount()
  }

  await clock.advance(301_000)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '○ cold' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' · next msg $0.30 · ctx 60k/200k ' })).toBeDefined()
})

test('a subagent turn keeps the band unchanged and skips that calibration sample', async ($, on) => {
  const cost = { usd: 0 }
  bandUsage(on, cost)
  on('turn.complete', () => ({ text: '' }))

  const turn = { answer: '', durationMs: 1, isAborted: false, reason: 'answer', usage: TURN_USAGE } as const
  await $.turn.complete({ ...turn, turnId: 's1', agentId: 'sub' })
  const empty = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await empty.find({ type: 'Text', text: /warm/ })).toBeUndefined()

  cost.usd = 5
  await $.turn.complete({ ...turn, turnId: 't1' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // No calibrated sample yet: the price is the list price, marked as approximate.
  expect(await ui.find({ type: 'Text', text: /next msg ~\$[\d.]+ \(cold ~\$/ })).toBeDefined()
})

test('the command toggles the band', async ($, on) => {
  bandUsage(on, { usd: 0.099 })
  on('turn.complete', () => ({ text: '' }))
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: TURN_USAGE })

  const toggle = () =>
    $.command.run({
      command: 'cache-gauge',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 },
    })

  await toggle()
  const hidden = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await hidden.find({ type: 'Text', text: /warm/ })).toBeUndefined()

  await toggle()
  const shown = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await shown.find({ type: 'Text', text: /warm/ })).toBeDefined()
})

test('the band still goes cold when the machine slept through the TTL', async ($, on) => {
  // A hand-driven clock: a sleep moves the wall clock with no tick in between.
  let t = 0
  let periods: Array<() => void> = []
  const tick = async () => {
    const due = periods
    periods = []
    due.forEach(resolve => resolve())
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  on('clock.now', () => ({ value: t }))
  on('clock.every', () => new Promise<{ value: undefined }>(resolve => periods.push(() => resolve({ value: undefined }))))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 60_000, window: 200_000, percent: 30 }, rateLimits: [], cost: { usd: 0.099 } },
  }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.render', () => ({ type: 'Box', children: [] }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.complete({
    answer: '',
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    usage: TURN_USAGE,
  })
  t = 60_000
  await tick()

  t += 3_600_000
  await tick()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '○ cold' })).toBeDefined()
})

test('ctx is measured against the compaction threshold', async ($, on) => {
  mock.clock(on)
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: {
        tokens: 238_000,
        window: 1_000_000,
        percent: 24,
        breakdown: { rawMaxTokens: 400_000, autoCompactThreshold: 367_000, isAutoCompactEnabled: true },
      },
      rateLimits: [],
      cost: { usd: 0.099 },
    },
  }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.render', () => ({ type: 'Box', children: [] }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.complete({
    answer: '',
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    usage: TURN_USAGE,
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // Measured against where compaction runs, not the model's 1M or the 400k window.
  expect(await ui.find({ type: 'Text', text: / · ctx 238k\/367k $/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' 65%' })).toBeDefined()
})

test('the band draws the context at start, before any reply', async ($, on) => {
  bandUsage(on, { usd: 0 })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '◌ waiting for a reply' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' · ctx 60k/200k ' })).toBeDefined()
})

test('show and hide set the band, a bare command toggles it', async ($, on) => {
  bandUsage(on, { usd: 0.099 })
  on('turn.complete', () => ({ text: '' }))
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: TURN_USAGE })
  const run = async (args: string) => {
    await $.command.run({
      command: 'cache-gauge',
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 },
    })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    return (await ui.find({ type: 'Text', text: /warm/ })) !== undefined
  }

  expect(await run('show')).toBe(true)
  expect(await run('show')).toBe(true)
  expect(await run('hide')).toBe(false)
  expect(await run('hide')).toBe(false)
  expect(await run('')).toBe(true)
})

test('the band keeps the line another mod draws beneath it', async ($, on) => {
  bandUsage(on, { usd: 0.099 }, { type: 'Text', props: {}, children: ['↻ keepalive 3/24'] })
  on('turn.complete', () => ({ text: '' }))
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: TURN_USAGE })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '● warm 5:00' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '↻ keepalive 3/24' })).toBeDefined()
})

test('a compaction redraws the context and the cache as cold', async ($, on) => {
  bandUsage(on, { usd: 0.099 })
  on('turn.complete', () => ({ text: '' }))
  const summary = [{ role: 'user', text: 'summary', toolUses: [] }] as const
  on('session.compact', () => ({ messages: summary, tokensBefore: 60_000, tokensAfter: 12_000 }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: TURN_USAGE })

  await $.session.compact({ trigger: 'manual', messages: summary })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '○ cold' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: / · ctx 12k\/200k $/ })).toBeDefined()
})

test('a /model switch prices the other model and leaves its cache cold until switched back', async ($, on) => {
  const cost = { usd: 0 }
  bandUsage(on, cost)
  on('turn.complete', () => ({ text: '' }))
  let model = OPUS
  on('session.model', () => ({ value: model }))
  on('command.run', { command: 'model' }, () => ({ text: '' }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  cost.usd = 0.099
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: TURN_USAGE })
  const switchTo = (to: string) => {
    model = to

    return $.command.run({
      command: 'model',
      args: to,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 },
    })
  }

  await switchTo('claude-sonnet-5-5')
  const sonnet = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await sonnet.find({ type: 'Text', text: '○ cold' })).toBeDefined()
  // Uncalibrated on Sonnet: list input 2e-6, cold = 60000 * 1.25 * 2e-6
  expect(await sonnet.find({ type: 'Text', text: ' · next msg ~$0.15 · ctx 60k/200k ' })).toBeDefined()
  await sonnet.unmount()

  await switchTo(OPUS)
  const back = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await back.find({ type: 'Text', text: '● warm 5:00' })).toBeDefined()
  expect(await back.find({ type: 'Text', text: ' · next msg $0.01 (cold $0.30) · ctx 60k/200k ' })).toBeDefined()
})

test('each request of a long turn restarts the countdown', async ($, on) => {
  const clock = bandUsage(on, { usd: 0.099 })
  on('turn.complete', () => ({ text: '' }))
  const step = { turnId: 't2', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', usage: TURN_USAGE } as const
  on('turn.step', async function* () {
    return step
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: TURN_USAGE })

  await clock.advance(200_000)
  // The step streams: drain it so the hooks run to its result.
  for await (const chunk of $.turn.step({ turnId: 't2', index: 0, model: OPUS, messageCount: 3 })) {
    void chunk
  }
  await clock.advance(200_000)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '● warm 1:40' })).toBeDefined()
  await ui.unmount()

  // While the turn runs the countdown would only keep resetting, so it is left out.
  const working = await $.ui.mount({ ...BAND, props: { ...BAND.props, isWorking: true }, surface: 'terminal' })
  expect(await working.find({ type: 'Text', text: '● warm' })).toBeDefined()
})

test('default options leave PromptHint to the engine: no tail is set', async ($, on) => {
  answerUsage(on, { usd: 0.099 })
  on('turn.complete', () => ({ text: '' }))
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: TURN_USAGE })

  expect(await hintTail(v => $.ui.mount(v))).toBeUndefined()
})

test('position hint leaves AbovePrompt to the engine: nothing of the band is drawn', { options: HINT_OPTIONS }, async ($, on) => {
  answerUsage(on, { usd: 0.099 })
  on('turn.complete', () => ({ text: '' }))
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: TURN_USAGE })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /warm/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /ctx/ })).toBeUndefined()
})

// herdr: the process.run beneath the mod answers `printf $HERDR_PANE_ID` with `pane` and records the report calls.
const PANE = 'w4:p1'
const DAY = '86400000'
const SRC = ['herdr', 'pane', 'report-metadata', PANE, '--source', 'cache-gauge']
const REPORT = [...SRC, '--token']
const agent = (name: string) => [...SRC, '--display-agent', name, '--agent', 'claude']
const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '' } }) as never
const herdrCalls = (on: On, pane: string, isBroken = false) => {
  const calls: string[][] = []
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'sh') {
      return ok(pane)
    }
    calls.push([...e.argv])

    return isBroken ? ({ deny: 'herdr is not installed' } as never) : ok('')
  })

  return calls
}
// The reports are fire-and-forget: let them run before looking.
const flush = () => new Promise(resolve => setTimeout(resolve, 5))
const reply = ($: Parameters<Parameters<typeof test>[1]>[0]) =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: TURN_USAGE })

test('outside herdr nothing is reported', async ($, on) => {
  const calls = herdrCalls(on, '')
  bandUsage(on, { usd: 0.099 })
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await reply($)
  await flush()

  expect(calls).toEqual([])
})

test('in herdr the start reports waiting, a reply reports warm with its lifetime and ctx apart', async ($, on) => {
  const calls = herdrCalls(on, PANE)
  bandUsage(on, { usd: 0.099 })
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await flush()
  expect(calls).toEqual([[...REPORT, 'cache=waiting'], [...REPORT, 'ctx=30', '--ttl-ms', DAY]])

  await reply($)
  await flush()
  expect(calls.slice(2)).toEqual([agent('opus 5.5'), [...REPORT, 'cache=warm 5m', '--ttl-ms', '300000']])
})

test('the warm token carries the time left, and the TTL crossing reports cold without one', async ($, on) => {
  const calls = herdrCalls(on, PANE)
  const clock = bandUsage(on, { usd: 0.099 })
  on('turn.complete', () => ({ text: '' }))
  let model = OPUS
  on('session.model', () => ({ value: model }))
  on('command.run', { command: 'model' }, () => ({ text: '' }))
  const switchTo = (to: string) => {
    model = to

    return $.command.run({
      command: 'model',
      args: to,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 },
    })
  }
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await reply($)
  await clock.advance(100_000)
  await switchTo('claude-sonnet-5-5')
  await switchTo(OPUS)
  await flush()
  expect(calls.slice(-4)).toEqual([
    agent('sonnet 5.5'),
    [...REPORT, 'cache=cold'],
    agent('opus 5.5'),
    [...REPORT, 'cache=warm 4m', '--ttl-ms', '200000'],
  ])

  await clock.advance(201_000)
  await flush()
  expect(calls.at(-1)).toEqual([...REPORT, 'cache=cold'])
})

test('values that did not change are not sent again; a new reply refreshes the warm lifetime', async ($, on) => {
  const calls = herdrCalls(on, PANE)
  const clock = bandUsage(on, { usd: 0.099 })
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await reply($)
  await flush()
  const sent = calls.length

  await clock.advance(30_000)
  await flush()
  expect(calls.length).toBe(sent)

  await reply($)
  await flush()
  expect(calls.slice(sent)).toEqual([[...REPORT, 'cache=warm 5m', '--ttl-ms', '300000']])
})

test('a compaction reports cold and the new context', async ($, on) => {
  const calls = herdrCalls(on, PANE)
  bandUsage(on, { usd: 0.099 })
  on('turn.complete', () => ({ text: '' }))
  const summary = [{ role: 'user', text: 'summary', toolUses: [] }] as const
  on('session.compact', () => ({ messages: summary, tokensBefore: 60_000, tokensAfter: 12_000 }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await reply($)
  await flush()
  const sent = calls.length

  await $.session.compact({ trigger: 'manual', messages: summary })
  await flush()

  expect(calls.slice(sent)).toEqual([[...REPORT, 'cache=cold'], [...REPORT, 'ctx=6', '--ttl-ms', DAY]])
})

test('a herdr that fails leaves the gauge drawing', async ($, on) => {
  const calls = herdrCalls(on, PANE, true)
  bandUsage(on, { usd: 0.099 })
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await reply($)
  await flush()

  expect(calls.length > 0).toBe(true)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '● warm 5:00' })).toBeDefined()
})

test('the countdown steps once a minute, ends at <1m, then cold', async ($, on) => {
  const calls = herdrCalls(on, PANE)
  const clock = bandUsage(on, { usd: 0.099 })
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await reply($)
  await clock.advance(301_000)
  await flush()

  // Each text once, however many ticks pass in its minute; a warm one carries the time left.
  expect(calls.filter(c => c.some(a => a.startsWith('cache='))).map(c => c.slice(7))).toEqual([
    ['cache=waiting'],
    ['cache=warm 5m', '--ttl-ms', '300000'],
    ['cache=warm 4m', '--ttl-ms', '240000'],
    ['cache=warm 3m', '--ttl-ms', '180000'],
    ['cache=warm 2m', '--ttl-ms', '120000'],
    ['cache=warm <1m', '--ttl-ms', '60000'],
    ['cache=cold'],
  ])
})

test('mid-turn the cache token is plain warm, and the countdown returns with the turn end', async ($, on) => {
  const calls = herdrCalls(on, PANE)
  const clock = bandUsage(on, { usd: 0.099 })
  on('turn.complete', () => ({ text: '' }))
  const step = { turnId: 't2', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', usage: TURN_USAGE } as const
  on('turn.step', async function* () {
    return step
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await reply($)
  await clock.advance(30_000)
  for await (const chunk of $.turn.step({ turnId: 't2', index: 0, model: OPUS, messageCount: 3 })) {
    void chunk
  }
  await clock.advance(100_000)
  await flush()
  expect(calls.at(-1)).toEqual([...REPORT, 'cache=warm', '--ttl-ms', '300000'])

  await reply($)
  await flush()
  expect(calls.at(-1)).toEqual([...REPORT, 'cache=warm 5m', '--ttl-ms', '300000'])
})

test('the end of the session clears both tokens', async ($, on) => {
  const calls = herdrCalls(on, PANE)
  bandUsage(on, { usd: 0.099 })
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await flush()
  const sent = calls.length

  await $.session.end({ reason: 'other', sessionId: 's1', resume: { id: 's1' } })

  expect(calls.slice(sent)).toEqual([
    [...SRC, '--clear-token', 'cache', '--clear-token', 'ctx', '--clear-display-agent'],
  ])
})

test('outside herdr the end of the session calls nothing', async ($, on) => {
  const calls = herdrCalls(on, '')
  bandUsage(on, { usd: 0.099 })
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.session.end({ reason: 'other', sessionId: 's1', resume: { id: 's1' } })

  expect(calls).toEqual([])
})

test('the display agent is the model, short', () => {
  expect(shortModel('us.anthropic.claude-opus-5-5')).toBe('opus 5.5')
  expect(shortModel('global.anthropic.claude-sonnet-4-6-v1:0')).toBe('sonnet 4.6')
  expect(shortModel('anthropic.claude-haiku-5')).toBe('haiku 5')
  expect(shortModel('claude-sonnet-4-6[1m]')).toBe('sonnet 4.6')
  expect(shortModel('claude-haiku-5-5-20260101')).toBe('haiku 5.5')
  expect(shortModel('claude-3-5-sonnet-20241022')).toBe('claude-3-5-sonnet-20241022')
  expect(shortModel('my-model')).toBe('my-model')
})
