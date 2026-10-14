import { expect, mock, test } from 'claude-code/testing'

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

test('each ping raises a notification with what idling has cost so far', async ($, on) => {
  const clock = mock.clock(on)
  const cost = { usd: 1 }
  const notes: string[] = []
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
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.notify', ($, e) => {
    notes.push(`${e.title}: ${e.text}`)
    return { value: { isSent: true, channel: 'iterm2' } } as never
  })
  on('ui.render', () => ({ type: 'Box', children: [] }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run(run('on'))
  await clock.advance(271_000)
  cost.usd = 1.03
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'p1', reason: 'answer' } as never)

  expect(notes).toEqual([
    'Cache keep-alive: Idle: ping 1/24, $0.03 spent with nobody working; keeps the cache warm ~1h48m more. Reply, or /cache-keepalive off.',
  ])
  await clock.advance(1000)
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: /^keepalive 1\/24 · \$0\.03 spent · next ping / })).toBeDefined()
})
