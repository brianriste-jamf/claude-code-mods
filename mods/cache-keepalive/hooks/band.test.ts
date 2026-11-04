import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const BAND = {
  plugin: 'cache-keepalive',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const run = (args: string) => ({
  command: 'cache-keepalive',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
}) as const

test('the band line appears when armed, keeps the line beneath it, and goes when off', async ($, on) => {
  const clock = mock.clock(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('settings.read', () => ({ value: {} }))
  on('env.get', () => ({ value: undefined }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 1_000_000, breakdown: { model: 'us.anthropic.claude-opus-5-5' } }, rateLimits: [] },
  }) as never)
  // Another mod's line beneath this one.
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['● warm 4:40'] }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const off = await $.ui.mount(BAND)
  expect(await off.find({ type: 'Text', text: /keepalive/ })).toBeUndefined()

  await $.command.run(run('on'))
  await clock.advance(60_000)
  const armed = await $.ui.mount(BAND)
  // The model is known from the start, so the budget is Opus 5.5's 24, not the generic 11.
  expect(await armed.find({ type: 'Text', text: /^keepalive 0\/24 · next ping 3:30 · keeps warm ~/ })).toBeDefined()
  expect(await armed.find({ type: 'Text', text: '● warm 4:40' })).toBeDefined()

  await $.command.run(run('off'))
  const disarmed = await $.ui.mount(BAND)
  expect(await disarmed.find({ type: 'Text', text: /keepalive/ })).toBeUndefined()
})

// A session whose fork is answered over a 200k-token prefix the cache serves (`hit`) or does not.
function idleSession(on: Parameters<TestBody>[1], fork: { hit: boolean }) {
  const cost = { usd: 1 }
  const notes: string[] = []
  const submitted: string[] = []
  const forks: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('settings.read', () => ({ value: {} }))
  on('env.get', () => ({ value: undefined }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      cost: { ...cost },
      context: { window: 1_000_000, breakdown: { model: 'us.anthropic.claude-opus-5-5' } },
      rateLimits: [],
    },
  }) as never)
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('model.fork', ($, e) => {
    forks.push(e.prompt)
    cost.usd += fork.hit ? 0.03 : 1.25
    const usage = fork.hit
      ? { input_tokens: 20, output_tokens: 1, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 0 }
      : { input_tokens: 200_020, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return { value: { isAnswered: true, text: 'ok', usage } } as never
  })
  on('ui.notify', ($, e) => {
    notes.push(`${e.title}: ${e.text}`)
    return { value: { isSent: true, channel: 'iterm2' } } as never
  })
  on('ui.render', () => ({ type: 'Box', children: [] }))

  return { notes, submitted, forks }
}

test('a ping is a fork: nothing enters the transcript, and it notifies what idling has cost', async ($, on) => {
  const clock = mock.clock(on)
  const s = idleSession(on, { hit: true })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run(run('on'))
  await clock.advance(271_000)

  expect(s.forks.length).toBe(1)
  expect(s.submitted).toEqual([])
  expect(s.notes).toEqual([
    'Cache keep-alive: Idle: ping 1/24, $0.03 spent with nobody working; keeps the cache warm ~1h48m more. Reply, or /cache-keepalive off.',
  ])
  await clock.advance(1000)
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: /^keepalive 1\/24 · \$0\.03 spent · next ping 4:2\d/ })).toBeDefined()
})

test('a ping restarts the idle clock, so the cache is kept warm past its first lifetime', async ($, on) => {
  const clock = mock.clock(on)
  const s = idleSession(on, { hit: true })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run(run('on'))
  await clock.advance(271_000 + 270_000)

  expect(s.forks.length).toBe(2)
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: /^keepalive 2\/24 · .* · next ping / })).toBeDefined()
})

test('a ping that finds the cache gone stops pinging until the next reply', async ($, on) => {
  const clock = mock.clock(on)
  const s = idleSession(on, { hit: false })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run(run('on'))
  await clock.advance(271_000 + 600_000)

  expect(s.forks.length).toBe(1)
  expect(s.notes).toEqual([])
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: /cache already cold, nothing to keep warm$/ })).toBeDefined()
})
