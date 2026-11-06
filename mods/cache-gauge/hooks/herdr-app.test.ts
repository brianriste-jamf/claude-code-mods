import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Snapshot } from '../types'
import { createHerdrApp } from './herdr-app'
import type { AppIo } from './herdr-app'
import { HERDR_APP_BUNDLE_ID } from './register'

const HOME = '/home/u'
const DIR = `${HOME}/.cache/cache-gauge/herdr-app`
const OPUS = 'us.anthropic.claude-opus-5-5'
const snap = (patch: Partial<Snapshot> = {}): Snapshot => ({
  ctxTokens: 60_000,
  window: 200_000,
  compactAt: null,
  respondedAt: 1_000_000,
  isCompacted: false,
  model: OPUS,
  currentModel: OPUS,
  baseUsd: 4e-6,
  isCalibrated: true,
  ...patch,
})

// An in-memory file system that records every operation in order.
const BIN = '/home/u/.local/bin/herdr-app'
const fake = (
  env: Record<string, string | undefined>,
  fails: Partial<Record<'mkdir' | 'write' | 'rename' | 'remove', boolean>> = {},
  bin: string | undefined = BIN,
) => {
  const files = new Map<string, string>()
  const ops: string[] = []
  const check = (op: keyof typeof fails) => {
    if (fails[op]) {
      throw new Error(`${op} failed`)
    }
  }
  const io: AppIo = {
    env: async name => env[name],
    mkdir: async dir => {
      check('mkdir')
      ops.push(`mkdir ${dir}`)
    },
    write: async (path, text) => {
      check('write')
      ops.push(`write ${path}`)
      files.set(path, text)
    },
    rename: async (from, to) => {
      check('rename')
      ops.push(`rename ${from} ${to}`)
      files.set(to, files.get(from) ?? '')
      files.delete(from)
    },
    remove: async path => {
      check('remove')
      ops.push(`remove ${path}`)
      files.delete(path)
    },
    which: async () => bin,
  }

  return { io, files, ops }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 5))
const start = async (env: Record<string, string | undefined>, ttl: '5m' | '1h' = '5m') => {
  const f = fake(env)
  const app = createHerdrApp(() => ttl)
  await app.detect(f.io, 's1')

  return { app, ...f }
}
const ON = { HC_TERMINAL_ID: 't1', HOME }

test('without HC_TERMINAL_ID, or with an invalid one, nothing is written', async () => {
  for (const id of [undefined, '', '  ', 't1; rm -rf', '../x', 'x', 't', 't1/', '/t1', 'a/b/t1', 'T1', 't1D', 't-1', 't1 x', 't1$(x)', 't1\n; x']) {
    const { app, ops } = await start({ HC_TERMINAL_ID: id, HOME })
    app.report(snap(), 5)
    await app.clear()
    await settle()
    expect([id, app.isOn, ops]).toEqual([id, false, []])
  }
  const noHome = await start({ HC_TERMINAL_ID: 't1' })
  noHome.app.report(snap(), 5)
  await settle()
  expect(noHome.ops).toEqual([])
})

test('a valid terminal id switches the reporter on', async () => {
  for (const id of ['t1', 'mac/t7', 'my-host.lan_2/t12', 't1b', 't1d', 't1h', 'mac/t1f']) {
    expect((await start({ HC_TERMINAL_ID: id, HOME })).app.isOn).toBe(true)
  }
})

test('the file holds the exact JSON shape', async () => {
  const { app, files } = await start(ON)
  app.report(snap(), 1_234_567)
  await settle()

  expect([...files.keys()]).toEqual([`${DIR}/t1.json`])
  expect(JSON.parse(files.get(`${DIR}/t1.json`) ?? '')).toEqual({
    v: 1,
    terminal: 't1',
    session_id: 's1',
    model: OPUS,
    model_short: 'opus 5.5',
    last_assistant_ms: 1_000_000,
    ttl_s: 300,
    updated_ms: 1_234_567,
  })
  expect(Object.keys(JSON.parse(files.get(`${DIR}/t1.json`) ?? ''))).toEqual([
    'v', 'terminal', 'session_id', 'model', 'model_short', 'last_assistant_ms', 'ttl_s', 'updated_ms',
  ])
})

test('no reply yet is 0, and the 1h lifetime is 3600', async () => {
  const { app, files } = await start(ON, '1h')
  app.report(snap({ respondedAt: null }), 9)
  await settle()
  const body = JSON.parse(files.get(`${DIR}/t1.json`) ?? '')
  expect([body.last_assistant_ms, body.ttl_s]).toEqual([0, 3600])
})

test('the file name replaces the slash of a remote terminal, the terminal field keeps it', async () => {
  const { app, files } = await start({ HC_TERMINAL_ID: 'mac/t7', HOME })
  app.report(snap(), 1)
  await settle()

  expect([...files.keys()]).toEqual([`${DIR}/mac_t7.json`])
  expect(JSON.parse(files.get(`${DIR}/mac_t7.json`) ?? '').terminal).toBe('mac/t7')
})

test('a terminal address with letters gets its own file', async () => {
  const { app, files } = await start({ HC_TERMINAL_ID: 'mac/t1f', HOME })
  app.report(snap(), 1)
  await settle()

  expect([...files.keys()]).toEqual([`${DIR}/mac_t1f.json`])
  expect(JSON.parse(files.get(`${DIR}/mac_t1f.json`) ?? '').terminal).toBe('mac/t1f')
})

test('the directory is made once, then the file goes to a temp name and is renamed into place', async () => {
  const { app, ops } = await start(ON)
  app.report(snap(), 1)
  app.report(snap({ respondedAt: 2_000_000 }), 2)
  await settle()

  expect(ops).toEqual([
    `mkdir ${DIR}`,
    `write ${DIR}/t1.json.tmp`,
    `rename ${DIR}/t1.json.tmp ${DIR}/t1.json`,
    `write ${DIR}/t1.json.tmp`,
    `rename ${DIR}/t1.json.tmp ${DIR}/t1.json`,
  ])
})

test('the final path is never written in place: a reader sees the old file or the whole new one', async () => {
  const f = fake(ON)
  const seen: string[] = []
  const write = f.io.write
  f.io.write = async (path, text) => {
    // Half the bytes land first, as in a real write.
    await write(path, text.slice(0, 10))
    seen.push(f.files.get(`${DIR}/t1.json`) ?? 'absent')
    await write(path, text)
  }
  const app = createHerdrApp(() => '5m')
  await app.detect(f.io, 's1')
  app.report(snap(), 1)
  await settle()

  expect(seen).toEqual(['absent'])
  expect(JSON.parse(f.files.get(`${DIR}/t1.json`) ?? '').v).toBe(1)
})

test('a model switch rewrites the file with the new model', async () => {
  const { app, files, ops } = await start(ON)
  app.report(snap(), 1)
  app.report(snap({ currentModel: 'claude-sonnet-4-6' }), 2)
  await settle()

  const body = JSON.parse(files.get(`${DIR}/t1.json`) ?? '')
  expect([body.model, body.model_short, body.updated_ms]).toEqual(['claude-sonnet-4-6', 'sonnet 4.6', 2])
  expect(ops.filter(op => op.startsWith('rename'))).toHaveLength(2)
})

test('a new reply rewrites the file', async () => {
  const { app, files } = await start(ON)
  app.report(snap(), 1)
  app.report(snap({ respondedAt: 7_000_000 }), 2)
  await settle()

  expect(JSON.parse(files.get(`${DIR}/t1.json`) ?? '').last_assistant_ms).toBe(7_000_000)
})

test('a compacted snapshot writes last_assistant_ms 0', async () => {
  const { app, files } = await start(ON)
  app.report(snap({ isCompacted: true }), 1)
  await settle()

  expect(JSON.parse(files.get(`${DIR}/t1.json`) ?? '').last_assistant_ms).toBe(0)
})

test('a model switch writes last_assistant_ms 0, and switching back restores the reply time', async () => {
  const { app, files, ops } = await start(ON)
  app.report(snap(), 1)
  app.report(snap({ currentModel: 'claude-sonnet-4-6' }), 2)
  await settle()
  expect(JSON.parse(files.get(`${DIR}/t1.json`) ?? '').last_assistant_ms).toBe(0)

  app.report(snap(), 3)
  await settle()
  expect(JSON.parse(files.get(`${DIR}/t1.json`) ?? '').last_assistant_ms).toBe(1_000_000)
  expect(ops.filter(op => op.startsWith('rename'))).toHaveLength(3)
})

test('a fork ping later than the reply moves last_assistant_ms to the ping time', async () => {
  const { app, files } = await start(ON)
  app.report(snap(), 2_000_000, 1_500_000)
  await settle()

  expect(JSON.parse(files.get(`${DIR}/t1.json`) ?? '').last_assistant_ms).toBe(1_500_000)
})

test('a fork ping earlier than the reply leaves last_assistant_ms at the reply time', async () => {
  const { app, files } = await start(ON)
  app.report(snap(), 2_000_000, 500_000)
  await settle()

  expect(JSON.parse(files.get(`${DIR}/t1.json`) ?? '').last_assistant_ms).toBe(1_000_000)
})

test('with no fork ping last_assistant_ms is the reply time', async () => {
  const { app, files } = await start(ON)
  app.report(snap(), 2_000_000)
  await settle()

  expect(JSON.parse(files.get(`${DIR}/t1.json`) ?? '').last_assistant_ms).toBe(1_000_000)
})

test('an unchanged value is not written again, whatever the clock says', async () => {
  const { app, ops } = await start(ON)
  app.report(snap(), 1)
  app.report(snap(), 2)
  app.report(snap(), 10_000)
  await settle()

  expect(ops.filter(op => op.startsWith('rename'))).toHaveLength(1)
})

test('a snapshot that is not there yet writes nothing', async () => {
  const { app, ops } = await start(ON)
  app.report(null, 1)
  await settle()

  expect(ops).toEqual([])
})

test('the end of the session deletes the file, and a value reported after it is written again', async () => {
  const { app, files, ops } = await start(ON)
  app.report(snap(), 1)
  await settle()
  await app.clear()

  expect(files.size).toBe(0)
  expect(ops.at(-1)).toBe(`remove ${DIR}/t1.json`)

  app.report(snap(), 2)
  await settle()
  expect(files.has(`${DIR}/t1.json`)).toBe(true)
})

test('the end of the session waits for a write still in flight, so the delete comes last', async () => {
  const { app, files } = await start(ON)
  app.report(snap(), 1)
  await app.clear()

  expect(files.size).toBe(0)
})

test('a session id that changes in place is written by the next report; empty and unchanged ids are ignored', async () => {
  const { app, files } = await start(ON)
  const read = () => JSON.parse(files.get(`${DIR}/t1.json`) ?? '{}').session_id
  app.report(snap(), 1)
  await settle()
  expect(read()).toBe('s1')

  app.setSession('')
  app.setSession('s1')
  app.report(snap(), 2)
  await settle()
  expect(JSON.parse(files.get(`${DIR}/t1.json`) ?? '{}').updated_ms).toBe(1)

  app.setSession('s2')
  app.report(snap(), 3)
  await settle()
  expect(read()).toBe('s2')
})

test('a file system that throws never throws out of the reporter, and the next report retries', async () => {
  for (const op of ['mkdir', 'write', 'rename', 'remove'] as const) {
    const f = fake(ON, { [op]: true })
    const app = createHerdrApp(() => '5m')
    await app.detect(f.io, 's1')
    app.report(snap(), 1)
    await app.clear()
    await settle()
    expect(app.isOn).toBe(true)
  }

  const f = fake(ON, { write: true })
  const app = createHerdrApp(() => '5m')
  await app.detect(f.io, 's1')
  app.report(snap(), 1)
  await settle()
  expect(f.files.size).toBe(0)
  const working = fake(ON)
  await app.detect({ ...working.io, env: f.io.env }, 's1')
  app.report(snap(), 2)
  await settle()
  expect(working.files.size).toBe(1)
})

test('an environment that throws leaves the reporter off', async () => {
  const f = fake(ON)
  const app = createHerdrApp(() => '5m')
  await app.detect({
    ...f.io,
    env: async () => {
      throw new Error('no env')
    },
  }, 's1')
  app.report(snap(), 1)
  await settle()
  expect([app.isOn, f.ops]).toEqual([false, []])
})

const focusOf = async (env: Record<string, string | undefined>, bin?: string) => {
  const f = fake(env, {}, bin)
  const app = createHerdrApp(() => '5m')
  await app.detect(f.io, 's1')

  return app.focusCommand
}

test('the focus command is empty when the reporter is off or herdr-app has no absolute path', async () => {
  expect(await focusOf({ HOME })).toBe('')
  expect(await focusOf({ HC_TERMINAL_ID: 't1; x', HOME })).toBe('')
  for (const bin of ['', '  ', 'herdr-app', 'bin/herdr-app']) {
    expect([bin, await focusOf(ON, bin)]).toEqual([bin, ''])
  }
  const f = fake(ON)
  for (const which of [async () => undefined, async () => Promise.reject(new Error('no sh'))]) {
    const app = createHerdrApp(() => '5m')
    await app.detect({ ...f.io, which }, 's1')
    expect([app.isOn, app.focusCommand]).toEqual([true, ''])
  }
})

test('the focus command is the quoted herdr-app path and terminal id', async () => {
  expect(await focusOf({ HC_TERMINAL_ID: 't7', HOME })).toBe(`'${BIN}' do agent.focus --terminal 't7'`)
  expect(await focusOf({ HC_TERMINAL_ID: 'mac/t7', HOME })).toBe(`'${BIN}' do agent.focus --terminal 'mac/t7'`)
  expect(await focusOf({ HC_TERMINAL_ID: 't1d', HOME })).toBe(`'${BIN}' do agent.focus --terminal 't1d'`)
})

test('a path with a space and a single quote stays one quoted word', async () => {
  expect(await focusOf(ON, "/Users/o'brien/My Apps/herdr-app")).toBe(
    "'/Users/o'\\''brien/My Apps/herdr-app' do agent.focus --terminal 't1'",
  )
})

test('a new detect forgets the earlier path', async () => {
  const f = fake(ON)
  const app = createHerdrApp(() => '5m')
  await app.detect(f.io, 's1')
  await app.detect(fake({ HOME }).io, 's1')
  expect(app.focusCommand).toBe('')
})

// The mod end to end: the engine beneath answers env, fs and process.run, and the gauge's own hooks drive the reporter.
const OPUS_ID = 'claude-opus-5-5'
const TURN_USAGE = {
  input_tokens: 1000,
  output_tokens: 2000,
  cache_read_input_tokens: 50_000,
  cache_creation_input_tokens: 9000,
  model: OPUS_ID,
}
const wire = (on: On, env: Record<string, string>, answer: (argv: string[]) => string = () => '') => {
  const clock = mock.clock(on)
  const writes: { path: string; text: string }[] = []
  const commands: string[][] = []
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 60_000, window: 200_000, percent: 30 }, rateLimits: [], cost: { usd: 0.099 } },
  }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  on('settings.read', () => ({ value: {} }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  const session = { id: 'sess-1' }
  on('session.id', () => ({ value: session.id }))
  on('ui.render', () => ({ type: 'Box', children: [] }))
  on('turn.complete', () => ({ text: '' }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('fs.write', (_$, e) => {
    writes.push({ path: e.path, text: e.text })

    return { value: undefined } as never
  })
  on('process.run', (_$, e) => {
    commands.push([...e.argv])

    return { value: { exitCode: 0, stdout: answer([...e.argv]), stderr: '' } } as never
  })

  return { clock, writes, commands, session }
}

test('in an hc terminal the mod writes the state file after a reply and removes it at the end', async ($, on) => {
  const { clock, writes, commands } = wire(on, { HC_TERMINAL_ID: 'mac/t7', HOME })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.advance(5000)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: TURN_USAGE })
  await settle()

  const file = `${DIR}/mac_t7.json`
  expect(writes.every(w => w.path === `${file}.tmp`)).toBe(true)
  const last = JSON.parse(writes.at(-1)?.text ?? '')
  expect([last.terminal, last.session_id, last.model, last.model_short, last.ttl_s]).toEqual([
    'mac/t7', 'sess-1', OPUS_ID, 'opus 5.5', 300,
  ])
  expect(last.last_assistant_ms).toBeGreaterThan(0)
  expect(commands).toContainEqual(['mkdir', '-p', '-m', '700', DIR])
  expect(commands).toContainEqual(['mv', '-f', `${file}.tmp`, file])

  await $.session.end({ reason: 'other', sessionId: 's1', resume: { id: 's1' } })
  expect(commands.at(-1)).toEqual(['rm', '-f', file])
})

test('after /clear the state file is rewritten under the new session id', async ($, on) => {
  const { clock, writes, commands, session } = wire(on, { HC_TERMINAL_ID: 't1', HOME })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.advance(5000)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: TURN_USAGE })
  await settle()
  expect(JSON.parse(writes.at(-1)?.text ?? '').session_id).toBe('sess-1')

  session.id = 'sess-2'
  await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } })
  await settle()

  const file = `${DIR}/t1.json`
  expect(commands).toContainEqual(['rm', '-f', file])
  expect(JSON.parse(writes.at(-1)?.text ?? '').session_id).toBe('sess-2')
  expect(commands.at(-1)).toEqual(['mv', '-f', `${file}.tmp`, file])
})

test('a session id that changes without a session.end reaches the file on the next tick', async ($, on) => {
  const { clock, writes, session } = wire(on, { HC_TERMINAL_ID: 't1', HOME })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.advance(5000)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: TURN_USAGE })
  await settle()

  session.id = 'sess-3'
  await clock.advance(1000)
  await settle()
  expect(JSON.parse(writes.at(-1)?.text ?? '').session_id).toBe('sess-3')
})

test('a fork ping stored by cache-keepalive reaches the state file', async ($, on) => {
  const { clock, writes } = wire(on, { HC_TERMINAL_ID: 't1', HOME })
  // cache-keepalive is not loaded: answer its atom ourselves, and leave every other atom to the mod.
  let pingedAt = 0
  on('state.get' as never, (async (
    _$: unknown,
    e: { plugin: string; key: string },
    next: (e: unknown) => Promise<{ value: object }>,
  ) => {
    const got = await next(e)

    return e.plugin === 'cache-keepalive' && e.key === 'lastPingAt'
      ? { value: { ...got.value, value: pingedAt } }
      : got
  }) as never)

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.advance(5000)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: TURN_USAGE })
  await settle()
  expect(JSON.parse(writes.at(-1)?.text ?? '').last_assistant_ms).toBe(5000)

  // A ping at 200 s is a cache read later than the reply: the next tick rewrites the file with its time.
  pingedAt = 200_000
  await clock.advance(1000)
  await settle()
  expect(JSON.parse(writes.at(-1)?.text ?? '').last_assistant_ms).toBe(200_000)
})

test('outside an hc terminal the mod touches neither the file system nor mv and rm', async ($, on) => {
  const { writes, commands } = wire(on, { HOME })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: TURN_USAGE })
  await $.session.end({ reason: 'other', sessionId: 's1', resume: { id: 's1' } })
  await settle()

  expect([writes, commands.filter(c => c[0] !== 'sh')]).toEqual([[], []])
})

// The notification the alarm raises 275 s after a reply, as the argv terminal-notifier receives it after `-group`.
const clickOf = async ($: Parameters<Parameters<typeof test>[1]>[0], on: On, env: Record<string, string>, answer: (argv: string[]) => string) => {
  const { clock, commands } = wire(on, env, answer)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: TURN_USAGE })
  await clock.advance(275_000)
  await settle()
  const notice = commands.find(argv => argv[0] === 'terminal-notifier' && !argv.includes('-remove'))

  return notice === undefined ? undefined : notice.slice(notice.indexOf('-group') + 2)
}
const script = (argv: string[]) => argv[2] ?? ''
const NO_PANE = (argv: string[]) => (script(argv) === 'command -v herdr-app' ? BIN : '')
const IN_PANE = (argv: string[]) => {
  if (script(argv) === 'command -v herdr-app') {
    return BIN
  }

  return script(argv).includes('HERDR_SOCKET_PATH') ? '/tmp/h.sock\n/opt/homebrew/bin/herdr' : 'w4:p1'
}

test('in an hc terminal without HERDR_PANE_ID the notification click focuses the agent in the Herdr app', async ($, on) => {
  expect(HERDR_APP_BUNDLE_ID).toBe('dev.herdr.app')
  expect(await clickOf($, on, { HC_TERMINAL_ID: 't7', HOME }, NO_PANE)).toEqual([
    '-activate',
    'dev.herdr.app',
    '-execute',
    `'${BIN}' do agent.focus --terminal 't7'`,
  ])
})

test('in an hc terminal with a herdr pane the click is still the Ghostty and herdr command', async ($, on) => {
  expect(await clickOf($, on, { HC_TERMINAL_ID: 't7', HOME }, IN_PANE)).toEqual([
    '-activate',
    'com.mitchellh.ghostty',
    '-execute',
    "HERDR_SOCKET_PATH='/tmp/h.sock' '/opt/homebrew/bin/herdr' agent focus 'w4:p1'",
  ])
})

test('outside hc the notification has no click', async ($, on) => {
  expect(await clickOf($, on, { HOME }, NO_PANE)).toEqual([])
})

test('in an hc terminal where herdr-app is not found the notification has no click', async ($, on) => {
  expect(await clickOf($, on, { HC_TERMINAL_ID: 't7', HOME }, () => '')).toEqual([])
})
