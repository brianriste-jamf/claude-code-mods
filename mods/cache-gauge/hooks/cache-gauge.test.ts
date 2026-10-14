import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

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

// What the engine would answer beneath the mod.
const answerUsage = (on: On, cost: { usd: number }, below: object = { type: 'Box', children: [] }) => {
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
  answerUsage(on, cost)
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
  answerUsage(on, { usd: 0 })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '◌ waiting for a reply' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' · ctx 60k/200k ' })).toBeDefined()
})

test('show and hide set the band, a bare command toggles it', async ($, on) => {
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
  answerUsage(on, { usd: 0.099 }, { type: 'Text', props: {}, children: ['↻ keepalive 3/24'] })
  on('turn.complete', () => ({ text: '' }))
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: TURN_USAGE })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '● warm 5:00' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '↻ keepalive 3/24' })).toBeDefined()
})

test('a compaction redraws the context and the cache as cold', async ($, on) => {
  answerUsage(on, { usd: 0.099 })
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
