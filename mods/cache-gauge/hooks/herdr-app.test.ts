import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Snapshot } from '../types'
import { createHerdrApp } from './herdr-app'
import type { AppIo } from './herdr-app'

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
const fake = (env: Record<string, string | undefined>, fails: Partial<Record<'mkdir' | 'write' | 'rename' | 'remove', boolean>> = {}) => {
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
  for (const id of [undefined, '', '  ', 't1; rm -rf', '../x', 'x', 't', 't1/', '/t1', 'a/b/t1', 'mac/t1x', 't1\n; x']) {
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
  for (const id of ['t1', 'mac/t7', 'my-host.lan_2/t12']) {
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

// The mod end to end: the engine beneath answers env, fs and process.run, and the gauge's own hooks drive the reporter.
const OPUS_ID = 'claude-opus-5-5'
const TURN_USAGE = {
  input_tokens: 1000,
  output_tokens: 2000,
  cache_read_input_tokens: 50_000,
  cache_creation_input_tokens: 9000,
  model: OPUS_ID,
}
const wire = (on: On, env: Record<string, string>) => {
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
  on('session.id', () => ({ value: 'sess-1' }))
  on('ui.render', () => ({ type: 'Box', children: [] }))
  on('turn.complete', () => ({ text: '' }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('fs.write', (_$, e) => {
    writes.push({ path: e.path, text: e.text })

    return { value: undefined } as never
  })
  on('process.run', (_$, e) => {
    commands.push([...e.argv])

    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })

  return { clock, writes, commands }
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

test('outside an hc terminal the mod touches neither the file system nor mv and rm', async ($, on) => {
  const { writes, commands } = wire(on, { HOME })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: TURN_USAGE })
  await $.session.end({ reason: 'other', sessionId: 's1', resume: { id: 's1' } })
  await settle()

  expect([writes, commands.filter(c => c[0] !== 'sh')]).toEqual([[], []])
})
