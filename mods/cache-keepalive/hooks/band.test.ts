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
  // Another mod's line beneath this one.
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['● warm 4:40'] }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const off = await $.ui.mount(BAND)
  expect(await off.find({ type: 'Text', text: /keepalive/ })).toBeUndefined()

  await $.command.run(run('on'))
  await clock.advance(60_000)
  const armed = await $.ui.mount(BAND)
  expect(await armed.find({ type: 'Text', text: /^keepalive 0\/\d+ · next ping 3:30 · keeps warm ~/ })).toBeDefined()
  expect(await armed.find({ type: 'Text', text: '● warm 4:40' })).toBeDefined()

  await $.command.run(run('off'))
  const disarmed = await $.ui.mount(BAND)
  expect(await disarmed.find({ type: 'Text', text: /keepalive/ })).toBeUndefined()
})
