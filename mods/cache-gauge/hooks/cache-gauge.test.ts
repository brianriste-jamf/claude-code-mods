import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { alarmMode, alarmPhase, coldText, endingText } from './alarm'
import { shortModel } from './herdr'
import { bar, calibrate, level, nextCost, ratesFor, usd, weightedUnits } from './pricing'

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
const ABOVE_OPTIONS = { position: 'above' } as const
const COLOR_OPTIONS = { position: 'hint', hintColor: 'on' } as const
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
  expect(ratesFor('us.anthropic.claude-sonnet-5-5').read).toBe(0.05)
  expect(ratesFor('claude-sonnet-5').read).toBe(0.1)
  near(ratesFor('claude-sonnet-4-6').input, 3e-6)
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

// Where Claude Code takes the cache lifetime from: no env var and no setting unless `env` has it.
const answerTtlControls = (on: On, env: Record<string, string> = {}, settings: Record<string, unknown> = {}) => {
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  on('settings.read', () => ({ value: settings }))
}

// What the engine would answer beneath the mod.
const answerUsage = (on: On, cost: { usd: number }, env: Record<string, string> = {}) => {
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
  answerTtlControls(on, env)
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
  expect(await hintTail(v => $.ui.mount(v))).toBe('  ○ cold · next msg $0.30 · ctx 60k/200k 30%')
})

test('the countdown follows CLAUDE_CODE_PROMPT_CACHE_TTL: 60 minutes, still warm past 5', async ($, on) => {
  const clock = answerUsage(on, { usd: 0.099 }, { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' })
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: TURN_USAGE })
  expect(await hintTail(v => $.ui.mount(v))).toBe('  ● warm 60:00 · ctx 60k/200k 30%')

  await clock.advance(301_000)
  expect(await hintTail(v => $.ui.mount(v))).toBe('  ● warm 54:59 · ctx 60k/200k 30%')
})

test('an explicit cacheTtl wins over the environment', { options: { cacheTtl: '5m' } }, async ($, on) => {
  answerUsage(on, { usd: 0.099 }, { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' })
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: TURN_USAGE })
  expect(await hintTail(v => $.ui.mount(v))).toBe('  ● warm 5:00 · ctx 60k/200k 30%')
})

test('the dot blinks in the last minute of the hint', { options: HINT_OPTIONS }, async ($, on) => {
  const clock = answerUsage(on, { usd: 0.099 })
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: TURN_USAGE })

  await clock.advance(239_000)
  expect(await hintTail(v => $.ui.mount(v))).toBe('  ● warm 1:01 · ctx 60k/200k 30%')
  const dots = []
  for (let i = 0; i < 2; i++) {
    await clock.advance(1000)
    dots.push((await hintTail(v => $.ui.mount(v)))?.trim()[0])
  }
  expect(dots.sort()).toEqual(['○', '●'])
})

test('hint colour draws the line itself: plain, yellow in the last minute, red when cold', { options: COLOR_OPTIONS }, async ($, on) => {
  const clock = answerUsage(on, { usd: 0.099 })
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: TURN_USAGE })
  const mount = async () => {
    tail = undefined
    const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
    // The engine's handler never runs, so no tail reaches it.
    expect(tail).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '? for shortcuts  ' })).toBeDefined()

    return ui
  }

  let ui = await mount()
  expect((await ui.find({ type: 'Text', text: '● warm 5:00' }))?.props).toEqual({ dimColor: true })
  await ui.unmount()

  await clock.advance(250_000)
  ui = await mount()
  expect((await ui.find({ type: 'Text', text: '● warm 0:50' }))?.props).toEqual({ color: 'warning' })
  await ui.unmount()

  await clock.advance(60_000)
  ui = await mount()
  expect((await ui.find({ type: 'Text', text: '○ cold · next msg ~$0.30' }))?.props).toEqual({ color: 'error' })
  expect(await ui.find({ type: 'Text', text: ' · ctx 60k/200k 30%' })).toBeDefined()
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
  answerTtlControls(on)
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

  expect(await hintTail(v => $.ui.mount(v))).toBe('  ○ cold · next msg ~$0.30 · ctx 60k/200k 30%')
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
  answerTtlControls(on)
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

test('a fresh session with no token count yet still draws the hint', { options: HINT_OPTIONS }, async ($, on) => {
  mock.clock(on)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  answerTtlControls(on)
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  captureTail(on)

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  expect(await hintTail(v => $.ui.mount(v))).toBe('  ◌ waiting · ctx 0/200k 0%')
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

  expect(await hintTail(v => $.ui.mount(v))).toBe('  ○ cold · next msg ~$0.06 · ctx 12k/200k 6%')
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
  expect(await hintTail(v => $.ui.mount(v))).toBe('  ○ cold · next msg ~$0.15 · ctx 60k/200k 30%')

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
  answerTtlControls(on)
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.render', () => below)

  return clock
}

test('the band shows the gauges after a turn and goes cold past the TTL', { options: ABOVE_OPTIONS }, async ($, on) => {
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

test('a subagent turn keeps the band unchanged and skips that calibration sample', { options: ABOVE_OPTIONS }, async ($, on) => {
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

test('the command toggles the band', { options: ABOVE_OPTIONS }, async ($, on) => {
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

test('the band still goes cold when the machine slept through the TTL', { options: ABOVE_OPTIONS }, async ($, on) => {
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
  answerTtlControls(on)
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

test('ctx is measured against the compaction threshold', { options: ABOVE_OPTIONS }, async ($, on) => {
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
  answerTtlControls(on)
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

test('the band draws the context at start, before any reply', { options: ABOVE_OPTIONS }, async ($, on) => {
  bandUsage(on, { usd: 0 })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '◌ waiting for a reply' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' · ctx 60k/200k ' })).toBeDefined()
})

test('show and hide set the band, a bare command toggles it', { options: ABOVE_OPTIONS }, async ($, on) => {
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

test('the band keeps the line another mod draws beneath it', { options: ABOVE_OPTIONS }, async ($, on) => {
  bandUsage(on, { usd: 0.099 }, { type: 'Text', props: {}, children: ['↻ keepalive 3/24'] })
  on('turn.complete', () => ({ text: '' }))
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: TURN_USAGE })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '● warm 5:00' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '↻ keepalive 3/24' })).toBeDefined()
})

test('a compaction redraws the context and the cache as cold', { options: ABOVE_OPTIONS }, async ($, on) => {
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

test('a /model switch prices the other model and leaves its cache cold until switched back', { options: ABOVE_OPTIONS }, async ($, on) => {
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

test('each request of a long turn restarts the countdown', { options: ABOVE_OPTIONS }, async ($, on) => {
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

test('position above leaves PromptHint to the engine: no tail is set', { options: ABOVE_OPTIONS }, async ($, on) => {
  answerUsage(on, { usd: 0.099 })
  on('turn.complete', () => ({ text: '' }))
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: TURN_USAGE })

  expect(await hintTail(v => $.ui.mount(v))).toBeUndefined()
})

test('default options draw the hint and leave the band to the engine', async ($, on) => {
  answerUsage(on, { usd: 0.099 })
  on('turn.complete', () => ({ text: '' }))
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: TURN_USAGE })

  expect(await hintTail(v => $.ui.mount(v))).toContain('ctx')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /ctx/ })).toBeUndefined()
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
    // The alarm's notifications are not herdr reports.
    if (e.argv[0] === 'terminal-notifier') {
      return ok('')
    }
    calls.push([...e.argv])

    return isBroken ? ({ deny: 'herdr is not installed' } as never) : ok('')
  })

  return calls
}
// The reports are fire-and-forget: let them run before looking.
const flush = () => new Promise(resolve => setTimeout(resolve, 5))
const answerTurn = ($: Parameters<Parameters<typeof test>[1]>[0]) =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: TURN_USAGE })

test('outside herdr nothing is reported', async ($, on) => {
  const calls = herdrCalls(on, '')
  bandUsage(on, { usd: 0.099 })
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await answerTurn($)
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

  await answerTurn($)
  await flush()
  expect(calls.slice(2)).toEqual([agent('opus 5.5'), [...REPORT, 'cache=warm 5m', '--ttl-ms', '300000']])
})

test('in herdr the start names the model before any reply, from the session', async ($, on) => {
  const calls = herdrCalls(on, PANE)
  bandUsage(on, { usd: 0.099 })
  on('session.model', () => ({ value: OPUS }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await flush()

  expect(calls[0]).toEqual(agent('opus 5.5'))
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
  await answerTurn($)
  await clock.advance(100_000)
  await switchTo('claude-sonnet-5-5')
  await switchTo(OPUS)
  await flush()
  expect(calls.slice(-4)).toEqual([
    agent('sonnet 5.5'),
    [...REPORT, 'cache=cold'],
    agent('opus 5.5'),
    [...REPORT, 'cache=warm 3.5m', '--ttl-ms', '200000'],
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
  await answerTurn($)
  await flush()
  const sent = calls.length

  await clock.advance(20_000)
  await flush()
  expect(calls.length).toBe(sent)

  await answerTurn($)
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
  await answerTurn($)
  await flush()
  const sent = calls.length

  await $.session.compact({ trigger: 'manual', messages: summary })
  await flush()

  expect(calls.slice(sent)).toEqual([
    [...REPORT, 'cache=compacting', '--ttl-ms', '600000'],
    [...REPORT, 'cache=cold'],
    [...REPORT, 'ctx=6', '--ttl-ms', DAY],
  ])
})

test('a herdr that fails leaves the gauge drawing', { options: ABOVE_OPTIONS }, async ($, on) => {
  const calls = herdrCalls(on, PANE, true)
  bandUsage(on, { usd: 0.099 })
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await answerTurn($)
  await flush()

  expect(calls.length > 0).toBe(true)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '● warm 5:00' })).toBeDefined()
})

test('the countdown steps every 30 s, ends at 0.5m, then cold', async ($, on) => {
  const calls = herdrCalls(on, PANE)
  const clock = bandUsage(on, { usd: 0.099 })
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await answerTurn($)
  await clock.advance(301_000)
  await flush()

  // Each text once, however many ticks pass in its step; a warm one carries the time left.
  const steps = [300, 270, 240, 210, 180, 150, 120, 90, 60, 30]
  expect(calls.filter(c => c.some(a => a.startsWith('cache='))).map(c => c.slice(7))).toEqual([
    ['cache=waiting'],
    ...steps.map(s => [`cache=warm ${s / 60}m`, '--ttl-ms', String(s * 1000)]),
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
  await answerTurn($)
  await clock.advance(30_000)
  for await (const chunk of $.turn.step({ turnId: 't2', index: 0, model: OPUS, messageCount: 3 })) {
    void chunk
  }
  await clock.advance(100_000)
  await flush()
  expect(calls.at(-1)).toEqual([...REPORT, 'cache=warm', '--ttl-ms', '300000'])

  await answerTurn($)
  await flush()
  // Anchored to the step's start, 100 s ago.
  expect(calls.at(-1)).toEqual([...REPORT, 'cache=warm 3.5m', '--ttl-ms', '200000'])
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

test('the alarm phases: a warning inside 1 min, the clip inside 15 s, nothing mid-turn or once cold', () => {
  expect(alarmPhase(61_000, true)).toBe('none')
  expect(alarmPhase(60_000, true)).toBe('notify')
  expect(alarmPhase(15_001, true)).toBe('notify')
  expect(alarmPhase(15_000, true)).toBe('sound')
  expect(alarmPhase(1, true)).toBe('sound')
  expect(alarmPhase(0, true)).toBe('none')
  expect(alarmPhase(10_000, false)).toBe('none')
  expect(alarmMode(undefined)).toBe('notify')
  expect(alarmMode('countdown')).toBe('countdown')
  expect(alarmMode('notify')).toBe('notify')
  expect(alarmMode('off')).toBe('off')
})

// Records what the alarm raises: toasts, notification calls (message and sound), removals, clips.
const recordAlarm = (on: On) => {
  const raised = { toasts: 0, notices: [] as { message: string; sound: boolean }[], removed: 0, clips: [] as string[] }
  on('ui.toast', () => {
    raised.toasts += 1

    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'terminal-notifier') {
      if (e.argv.includes('-remove')) {
        raised.removed += 1
      } else {
        raised.notices.push({ message: e.argv[e.argv.indexOf('-message') + 1] ?? '', sound: e.argv.includes('-sound') })
      }
    }

    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('audio.play', (_$, e) => {
    raised.clips.push(e.clip.asset ?? 'other')

    return { value: undefined }
  })

  return raised
}

// What the alarm quotes for the seeded session: 60k tokens of context, priced at `base`.
const quoted = (base: number, mark: string) => {
  const cost = nextCost(60_000, base, OPUS, '5m')

  return { warm: `${mark}${usd(cost.warm)}`, cold: `${mark}${usd(cost.cold)}` }
}

test('the notification steps: 1 min with sound and toast, 15 s and cold replace it silently, each with the prices', async ($, on) => {
  const raised = recordAlarm(on)
  const clock = answerUsage(on, { usd: 0 })
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await answerTurn($)
  // No usable cost sample, so the rate is the list one and the prices carry `~`.
  const prices = quoted(ratesFor(OPUS).input, '~')

  await clock.advance(230_000)
  expect(raised.notices).toEqual([])
  expect(raised.toasts).toBe(0)
  await clock.advance(10_000)
  expect(raised.notices).toEqual([
    { message: `Cache ending in 1m. Reply to keep your next message at ${prices.warm}; cold it costs ${prices.cold}.`, sound: true },
  ])
  expect(raised.notices[0]?.message).toContain('~$')
  expect(raised.toasts).toBe(1)
  await clock.advance(45_000)
  expect(raised.notices[1]).toEqual({
    message: `Cache ending in 15s. Reply to keep your next message at ${prices.warm}; cold it costs ${prices.cold}.`,
    sound: false,
  })
  await clock.advance(20_000)
  expect(raised.notices[2]).toEqual({
    message: `Cache is cold. Your next message costs ${prices.cold} (warm: ${prices.warm}).`,
    sound: false,
  })
  await clock.advance(60_000)
  expect(raised.notices.length).toBe(3)
  expect(raised.toasts).toBe(1)
  expect(raised.clips).toEqual([])
})

test('a calibrated session quotes its prices without the ~', async ($, on) => {
  const raised = recordAlarm(on)
  const cost = { usd: 0 }
  const clock = answerUsage(on, cost)
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  cost.usd = 0.099
  await answerTurn($)
  const base = calibrate(null, 0.099, weightedUnits(TURN_USAGE, OPUS, '5m')) ?? 0
  const prices = quoted(base, '')

  await clock.advance(240_000)
  expect(raised.notices[0]?.message).toBe(
    `Cache ending in 1m. Reply to keep your next message at ${prices.warm}; cold it costs ${prices.cold}.`,
  )
  expect(raised.notices[0]?.message).not.toContain('~')
})

test('the alarm texts fall back to no prices before there is a snapshot', () => {
  expect(endingText('1m', null)).toBe('Cache ending in 1m. Reply to keep it warm.')
  expect(endingText('15s', null)).toBe('Cache ending in 15s. Reply to keep it warm.')
  expect(coldText(null)).toBe('Cache is cold. The next message re-sends the full context.')
  const prices = { warm: '$0.06', cold: '~$1.56' }
  expect(endingText('1m', prices)).toBe('Cache ending in 1m. Reply to keep your next message at $0.06; cold it costs ~$1.56.')
  expect(coldText(prices)).toBe('Cache is cold. Your next message costs ~$1.56 (warm: $0.06).')
})

test('alarm countdown also starts the clip at 15 s, once', { options: { alarm: 'countdown' } }, async ($, on) => {
  const raised = recordAlarm(on)
  const clock = answerUsage(on, { usd: 0 })
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await answerTurn($)
  await clock.advance(284_000)
  expect(raised.clips).toEqual([])
  await clock.advance(1000)
  expect(raised.clips).toEqual(['sounds/countdown.mp3'])
  await clock.advance(40_000)
  expect(raised.clips.length).toBe(1)
})

test('alarm off raises nothing', { options: { alarm: 'off' } }, async ($, on) => {
  const raised = recordAlarm(on)
  const clock = answerUsage(on, { usd: 0 })
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await answerTurn($)
  await clock.advance(320_000)
  expect(raised).toMatchObject({ toasts: 0, notices: [], clips: [], removed: 0 })
})

test('a reply during the countdown removes the notification and starts a new period that warns again', async ($, on) => {
  const raised = recordAlarm(on)
  const clock = answerUsage(on, { usd: 0 })
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await answerTurn($)
  await clock.advance(275_000)
  expect(raised.notices.length).toBe(1)
  expect(raised.removed).toBe(0)
  await $.prompt.submit({ text: 'hi' })
  expect(raised.removed).toBe(1)
  await answerTurn($)
  await clock.advance(275_000)
  expect(raised.notices.length).toBe(2)
  expect(raised.toasts).toBe(2)
})

test('in herdr the notification click focuses this agent with herdr by full path and socket', async ($, on) => {
  const calls: string[][] = []
  on('process.run', (_$, e) => {
    calls.push([...e.argv])
    if (e.argv[0] === 'sh') {
      return ok(e.argv[2]?.includes('HERDR_PANE_ID') ? PANE : '/tmp/h.sock\n/opt/homebrew/bin/herdr')
    }

    return ok('')
  })
  const clock = answerUsage(on, { usd: 0 })
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: TURN_USAGE })
  await clock.advance(275_000)
  await flush()

  const notice = calls.find(argv => argv[0] === 'terminal-notifier')
  expect(notice?.slice(notice.indexOf('-activate'))).toEqual([
    '-activate',
    'com.mitchellh.ghostty',
    '-execute',
    "HERDR_SOCKET_PATH='/tmp/h.sock' '/opt/homebrew/bin/herdr' agent focus 'w4:p1'",
  ])
})

// Compaction in flight: the base handler runs beneath the mod's hook, while it awaits `next`.
const SUMMARY = [{ role: 'user', text: 'summary', toolUses: [] }] as const
const COMPACT = { trigger: 'manual', messages: SUMMARY } as const
const compactResult = { messages: SUMMARY, tokensBefore: 60_000, tokensAfter: 12_000 }

test('the hint shows compacting, not cold, while a compaction runs past the expiry', { options: HINT_OPTIONS }, async ($, on) => {
  const clock = answerUsage(on, { usd: 0.099 })
  on('turn.complete', () => ({ text: '' }))
  const during: (string | undefined)[] = []
  on('session.compact', async () => {
    await clock.advance(20_000)
    during.push(await hintTail(v => $.ui.mount(v)))

    return compactResult
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await answerTurn($)
  await clock.advance(285_000)

  await $.session.compact(COMPACT)

  expect(during[0]).toContain('◌ compacting')
  expect(during[0]).not.toContain('cold')
  expect(during[0]).toContain('ctx 60k/200k')
  expect(await hintTail(v => $.ui.mount(v))).toBe('  ○ cold · next msg ~$0.06 · ctx 12k/200k 6%')
})

test('the band shows compacting, not cold, while a compaction runs past the expiry', { options: ABOVE_OPTIONS }, async ($, on) => {
  const clock = bandUsage(on, { usd: 0.099 })
  on('turn.complete', () => ({ text: '' }))
  const during: { compacting: boolean; cold: boolean; dim: boolean }[] = []
  on('session.compact', async () => {
    await clock.advance(20_000)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const text = await ui.find({ type: 'Text', text: '◌ compacting' })
    during.push({
      compacting: text !== undefined,
      cold: (await ui.find({ type: 'Text', text: /cold/ })) !== undefined,
      dim: text?.props.dimColor === true,
    })
    await ui.unmount()

    return compactResult
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await answerTurn($)
  await clock.advance(285_000)

  await $.session.compact(COMPACT)

  expect(during).toEqual([{ compacting: true, cold: false, dim: true }])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '○ cold' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '◌ compacting' })).toBeUndefined()
})

test('herdr reports cache=compacting through the expiry of a compaction and cold after', async ($, on) => {
  const calls = herdrCalls(on, PANE)
  const clock = bandUsage(on, { usd: 0.099 })
  on('turn.complete', () => ({ text: '' }))
  let sent = 0
  const caches = () => calls.slice(sent).filter(c => c[REPORT.length]?.startsWith('cache=')).map(c => c.slice(REPORT.length))
  const during: string[][][] = []
  on('session.compact', async () => {
    await flush()
    during.push(caches())
    await clock.advance(20_000)
    await flush()
    during.push(caches())

    return compactResult
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await answerTurn($)
  await clock.advance(285_000)
  await flush()
  sent = calls.length

  await $.session.compact(COMPACT)
  await flush()

  // Before and after the expiry the only report is compacting, never cold.
  const compacting = [['cache=compacting', '--ttl-ms', '600000']]
  expect(during).toEqual([compacting, compacting])
  expect(caches()).toEqual([...compacting, ['cache=cold']])
})

test('a compaction takes the alarm notification down and keeps it quiet through the expiry', async ($, on) => {
  const raised = recordAlarm(on)
  const clock = answerUsage(on, { usd: 0 })
  on('turn.complete', () => ({ text: '' }))
  on('session.compact', async () => {
    await clock.advance(62_000)

    return compactResult
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await answerTurn($)
  await clock.advance(240_000)
  expect(raised.notices.length).toBe(1)
  expect(raised.removed).toBe(0)

  await $.session.compact(COMPACT)
  await flush()

  expect(raised.removed).toBe(1)
  expect(raised.notices.length).toBe(1)
  await clock.advance(120_000)
  expect(raised.notices.length).toBe(1)
})

test('a compaction that crosses the expiry posts no notification of its own', async ($, on) => {
  const raised = recordAlarm(on)
  const clock = answerUsage(on, { usd: 0 })
  on('turn.complete', () => ({ text: '' }))
  on('session.compact', async () => {
    await clock.advance(66_000)

    return compactResult
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await answerTurn($)
  await clock.advance(235_000)

  await $.session.compact(COMPACT)

  expect(raised.notices).toEqual([])
  expect(raised.toasts).toBe(0)
})

test('a precompute or subagent compaction does not set the compacting state', { options: HINT_OPTIONS }, async ($, on) => {
  const clock = answerUsage(on, { usd: 0.099 })
  on('turn.complete', () => ({ text: '' }))
  const during: (string | undefined)[] = []
  on('session.compact', async () => {
    await clock.advance(1000)
    during.push(await hintTail(v => $.ui.mount(v)))

    return compactResult
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await answerTurn($)

  await $.session.compact({ trigger: 'precompute', messages: SUMMARY })
  await $.session.compact({ ...COMPACT, agentId: 'sub-1' })

  expect(during.length).toBe(2)
  for (const tailText of during) {
    expect(tailText).toContain('warm')
    expect(tailText).not.toContain('compacting')
  }
})

// A subagent works while the main thread is idle: its steps and its completion arrive with an agentId.
const SUB_STEP = { turnId: 's1', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', usage: TURN_USAGE } as const
const answerSteps = (on: On) =>
  on('turn.step', async function* () {
    return SUB_STEP
  })
const subStep = async ($: Parameters<Parameters<typeof test>[1]>[0], agentId = 'sub') => {
  for await (const chunk of $.turn.step({ turnId: 's1', index: 0, model: OPUS, messageCount: 3, agentId })) {
    void chunk
  }
}
const subDone = ($: Parameters<Parameters<typeof test>[1]>[0], agentId = 'sub') =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 's1', reason: 'answer', usage: TURN_USAGE, agentId })

test('while a subagent works the hint shows agent working, stays quiet, and returns to cold when it completes', { options: { position: 'hint', alarm: 'countdown' } }, async ($, on) => {
  const raised = recordAlarm(on)
  const clock = answerUsage(on, { usd: 0.099 })
  on('turn.complete', () => ({ text: '' }))
  answerSteps(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await answerTurn($)

  await clock.advance(100_000)
  await subStep($)
  await clock.advance(250_000)

  const during = await hintTail(v => $.ui.mount(v))
  expect(during).toBe('  ◌ agent working · ctx 60k/200k 30%')
  expect(raised.notices).toEqual([])
  expect(raised.clips).toEqual([])
  expect(raised.toasts).toBe(0)

  await subDone($)
  await clock.advance(1000)
  expect(await hintTail(v => $.ui.mount(v))).toMatch(/^ {2}○ cold · next msg/)
})

test('hint colour leaves agent working dim', { options: COLOR_OPTIONS }, async ($, on) => {
  const clock = answerUsage(on, { usd: 0.099 })
  on('turn.complete', () => ({ text: '' }))
  answerSteps(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await answerTurn($)
  await clock.advance(301_000)
  await subStep($)

  const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: '◌ agent working' }))?.props).toEqual({ dimColor: true })
  expect(await ui.find({ type: 'Text', text: /cold/ })).toBeUndefined()
})

test('the band shows agent working while a subagent works', { options: ABOVE_OPTIONS }, async ($, on) => {
  const clock = bandUsage(on, { usd: 0.099 })
  on('turn.complete', () => ({ text: '' }))
  answerSteps(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await answerTurn($)
  await clock.advance(301_000)
  await subStep($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: '◌ agent working' }))?.props).toEqual({ dimColor: true })
  expect(await ui.find({ type: 'Text', text: /cold/ })).toBeUndefined()
  await ui.unmount()

  await subDone($)
  const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await after.find({ type: 'Text', text: '○ cold' })).toBeDefined()
})

test('a subagent with no step for 10 minutes stops counting', { options: HINT_OPTIONS }, async ($, on) => {
  const clock = answerUsage(on, { usd: 0.099 })
  on('turn.complete', () => ({ text: '' }))
  answerSteps(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await answerTurn($)
  await subStep($)

  await clock.advance(400_000)
  expect(await hintTail(v => $.ui.mount(v))).toContain('agent working')
  await clock.advance(250_000)
  const after = await hintTail(v => $.ui.mount(v))
  expect(after).toContain('○ cold')
  expect(after).not.toContain('agent working')
})

test('herdr reports cache=working while a subagent works, never cold, and cold after it completes', async ($, on) => {
  const calls = herdrCalls(on, PANE)
  const clock = bandUsage(on, { usd: 0.099 })
  on('turn.complete', () => ({ text: '' }))
  answerSteps(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await answerTurn($)
  await clock.advance(250_000)
  await flush()
  const caches = () => calls.filter(c => c[REPORT.length]?.startsWith('cache=')).map(c => c.slice(REPORT.length))
  const before = caches().length

  await subStep($)
  await flush()
  expect(caches().slice(before)).toEqual([['cache=working', '--ttl-ms', '600000']])

  await clock.advance(60_000)
  await flush()
  expect(caches().slice(before)).toEqual([['cache=working', '--ttl-ms', '600000']])

  await subDone($)
  await flush()
  expect(caches().slice(before)).toEqual([['cache=working', '--ttl-ms', '600000'], ['cache=cold']])
})

test('the alarm resumes when a stale subagent drops out', { options: { alarm: 'notify' } }, async ($, on) => {
  const raised = recordAlarm(on)
  const clock = answerUsage(on, { usd: 0 }, { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' })
  on('turn.complete', () => ({ text: '' }))
  answerSteps(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await answerTurn($)
  await subStep($)

  await clock.advance(3_530_000)
  expect(raised.notices).toEqual([])
  await clock.advance(20_000)
  expect(raised.notices.length).toBe(1)
  expect(raised.notices[0]?.message).toContain('Cache ending in 1m')
})

// The lifetime runs from the start of each main request: a step that takes `ctl.takes` ms advances the clock inside the engine's handler.
const MAIN_STEP = { turnId: 't2', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', usage: TURN_USAGE } as const
const answerMainSteps = (on: On, clock: ReturnType<typeof mock.clock>) => {
  const ctl = { takes: 0, noUsage: false, during: [] as (string | undefined)[], onTakes: async () => {} }
  on('turn.step', async function* () {
    await ctl.onTakes()
    await clock.advance(ctl.takes)

    return ctl.noUsage ? { ...MAIN_STEP, usage: null } : MAIN_STEP
  })

  return ctl
}
type Api = Parameters<Parameters<typeof test>[1]>[0]
const mainStep = async ($: Api) => {
  for await (const chunk of $.turn.step({ turnId: 't2', index: 0, model: OPUS, messageCount: 3 })) {
    void chunk
  }
}
const startTurn = ($: Api) => $.turn.start({ turnId: 't2' } as never)
const abortTurn = ($: Api) =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't2', reason: 'aborted' } as never)

test('a prompt sent with 45 s left stays warm and quiet through a long first response', { options: { position: 'hint', alarm: 'countdown' } }, async ($, on) => {
  const raised = recordAlarm(on)
  const clock = answerUsage(on, { usd: 0 })
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }) as never)
  const ctl = answerMainSteps(on, clock)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await answerTurn($)
  await clock.advance(255_000)
  expect(raised.notices.length).toBe(1)

  await $.prompt.submit({ text: 'hi' })
  expect(raised.removed).toBe(1)
  await startTurn($)
  const during: (string | undefined)[] = []
  // The old expiry passes 45 s into the request.
  ctl.takes = 50_000
  ctl.onTakes = async () => {
    await clock.advance(1000)
    during.push(await hintTail(v => $.ui.mount(v)))
  }
  await mainStep($)
  during.push(await hintTail(v => $.ui.mount(v)))

  expect(raised.notices.length).toBe(1)
  expect(raised.clips).toEqual([])
  for (const t of during) {
    expect(t).toContain('warm')
    expect(t).not.toContain('cold')
  }
  await answerTurn($)
  expect(raised.notices.length).toBe(1)
  expect(await hintTail(v => $.ui.mount(v))).toBe('  ● warm 4:09 · ctx 60k/200k 30%')
})

test('the countdown is anchored to the last step start: 4:00 right after a 60 s response, and the notice follows', { options: HINT_OPTIONS }, async ($, on) => {
  const raised = recordAlarm(on)
  const clock = answerUsage(on, { usd: 0 })
  on('turn.complete', () => ({ text: '' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }) as never)
  const ctl = answerMainSteps(on, clock)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await answerTurn($)
  await clock.advance(10_000)
  await startTurn($)
  ctl.takes = 60_000
  await mainStep($)
  await answerTurn($)

  expect(await hintTail(v => $.ui.mount(v))).toBe('  ● warm 4:00 · ctx 60k/200k 30%')
  await clock.advance(179_000)
  expect(raised.notices).toEqual([])
  await clock.advance(2000)
  expect(raised.notices.length).toBe(1)
})

test('a turn aborted before any request leaves the old countdown running and the alarm resumes', { options: HINT_OPTIONS }, async ($, on) => {
  const raised = recordAlarm(on)
  const clock = answerUsage(on, { usd: 0 })
  on('turn.complete', () => ({ text: '' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }) as never)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await answerTurn($)
  await clock.advance(100_000)

  await startTurn($)
  await clock.advance(150_000)
  // Active turn: the alarm is quiet even inside the last minute.
  expect(raised.notices).toEqual([])
  await abortTurn($)
  await clock.advance(1000)

  expect(raised.notices.length).toBe(1)
  expect(await hintTail(v => $.ui.mount(v))).toBe('  ● warm 0:49 · ctx 60k/200k 30%')
})

test('a step without usage still starts the lifetime and marks the turn active', { options: HINT_OPTIONS }, async ($, on) => {
  const raised = recordAlarm(on)
  const clock = answerUsage(on, { usd: 0 })
  on('turn.complete', () => ({ text: '' }))
  const ctl = answerMainSteps(on, clock)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await answerTurn($)
  await clock.advance(100_000)
  ctl.noUsage = true
  await mainStep($)

  await clock.advance(160_000)
  expect(raised.notices).toEqual([])
  expect(await hintTail(v => $.ui.mount(v))).toBe('  ● warm 2:20 · ctx 60k/200k 30%')
})

test('two steps in a row keep the cache warm and the expiry follows the second step start', { options: HINT_OPTIONS }, async ($, on) => {
  const clock = answerUsage(on, { usd: 0 })
  on('turn.complete', () => ({ text: '' }))
  const ctl = answerMainSteps(on, clock)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await answerTurn($)
  await clock.advance(10_000)
  ctl.takes = 20_000
  await mainStep($)
  await clock.advance(30_000)
  await mainStep($)
  await answerTurn($)

  // Second step started at 60 s and expires at 360 s; now is 80 s.
  expect(await hintTail(v => $.ui.mount(v))).toBe('  ● warm 4:40 · ctx 60k/200k 30%')
  await clock.advance(250_000)
  // The last minute blinks the dot.
  expect(await hintTail(v => $.ui.mount(v))).toMatch(/^ {2}[●○] warm 0:30 · ctx 60k\/200k 30%$/)
})

test('the fallback banner passes the message to osascript as an argument, not inside the script', async ($, on) => {
  const banners: string[][] = []
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'osascript') {
      banners.push([...e.argv])
    }

    // terminal-notifier is missing, so the alarm falls back to osascript.
    return { value: { exitCode: e.argv[0] === 'terminal-notifier' ? 127 : 0, stdout: '', stderr: '' } }
  })
  const clock = answerUsage(on, { usd: 0 })
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await answerTurn($)
  await clock.advance(240_000)

  const argv = banners[0] ?? []
  const message = argv.at(-1) ?? ''
  expect(message).toContain('Cache ending in 1m.')
  expect(argv.slice(0, -1).some(arg => arg.includes(message))).toBe(false)
  expect(argv).toContain('on run argv')
})
