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
// `takesMs` is how long the fork takes to answer, on `clock`.
// `during` runs while the fork is pending; `throws` makes the engine refuse the fork after that.
function idleSession(
  on: Parameters<TestBody>[1],
  fork: { hit: boolean; takesMs?: number; clock?: { advance(ms: number): Promise<unknown> }; during?: () => Promise<void>; throws?: boolean },
) {
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
  on('model.fork', async ($, e) => {
    forks.push(e.prompt)
    if (fork.takesMs) {
      await fork.clock?.advance(fork.takesMs)
    }
    await fork.during?.()
    if (fork.throws) {
      throw new Error('refused')
    }
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

const OPUS = 'us.anthropic.claude-opus-5-5'
const COMPLETE = {
  answer: '',
  durationMs: 1,
  isAborted: false,
  turnId: 't1',
  reason: 'answer',
  usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: OPUS },
} as const

test('the idle timer counts from the start of the last request, not the end of the reply', async ($, on) => {
  const clock = mock.clock(on)
  const s = idleSession(on, { hit: true })
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* () {
    return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: COMPLETE.usage } as const
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run(run('on'))
  await clock.advance(10_000)
  // The final request starts here, then streams for a minute.
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: OPUS, messageCount: 3 })) {
    void chunk
  }
  await clock.advance(60_000)
  await $.turn.complete(COMPLETE)

  // 90% of the 5m lifetime after the request started is 270s: 210s after the reply ended.
  await clock.advance(200_000)
  expect(s.forks.length).toBe(0)
  await clock.advance(11_000)
  expect(s.forks.length).toBe(1)
})

test('the next ping is timed from the previous ping\'s start, not its end', async ($, on) => {
  const clock = mock.clock(on)
  const s = idleSession(on, { hit: true, takesMs: 30_000, clock })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run(run('on'))
  // The first ping starts at 270s and ends at 300s; the second is due 270s after the first started.
  await clock.advance(270_000 + 270_000 - 5_000)
  expect(s.forks.length).toBe(1)
  await clock.advance(10_000)
  expect(s.forks.length).toBe(2)
})

test('while the fork is pending the band shows that it is pinging', async ($, on) => {
  const clock = mock.clock(on)
  let during: unknown
  let isChecked = false
  const s = idleSession(on, {
    hit: true,
    takesMs: 3_000,
    clock,
    during: async () => {
      // The tick that draws the band runs on its own: wait for its line rather than read the band once.
      during = await findLine($, /^keepalive 0\/24 · pinging…$/, clock)
      isChecked = true
    },
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run(run('on'))
  await clock.advance(270_000 + 5_000)
  // The tick that sends the fork runs on its own too: wait until the fork has reached `during`.
  await until(() => isChecked)

  expect(s.forks.length).toBe(1)
  expect(during).toBeDefined()
})

test('a subagent starting a turn after the main turn ended does not stop the next ping', async ($, on) => {
  const clock = mock.clock(on)
  const s = idleSession(on, { hit: true })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run(run('on'))
  await $.turn.start({ turnId: 't1' } as never)
  await $.turn.complete(COMPLETE)
  // A background subagent starts its turn while the main thread is idle, and never completes one here.
  await $.turn.start({ turnId: 's1', agentId: 'sub' } as never)

  await clock.advance(271_000)
  expect(s.forks.length).toBe(1)
})

// Ticks run on their own after `clock.advance` returns; wait for a condition rather than assume it already holds.
async function until(done: () => boolean) {
  for (let i = 0; i < 300 && !done(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

// The tick that draws the band runs on its own; wait for a line to appear rather than read the band once.
// With `clock`, each poll first runs one more tick, since none may follow the change being waited for.
async function findLine($: Parameters<TestBody>[0], text: RegExp, clock?: { advance(ms: number): Promise<unknown> }) {
  for (let i = 0; i < 100; i++) {
    const found = await (await $.ui.mount(BAND)).find({ type: 'Text', text })
    if (found) {
      return found
    }
    if (clock && i % 5 === 4) {
      await clock.advance(1_000)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return undefined
}

test('a main turn that never completes stops counting as busy after ten minutes', async ($, on) => {
  const clock = mock.clock(on)
  idleSession(on, { hit: true })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }) as never)

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run(run('on'))
  await clock.advance(1_000)
  await $.turn.start({ turnId: 't1' } as never)

  await clock.advance(300_000)
  expect(await (await $.ui.mount(BAND)).find({ type: 'Text', text: /waits for the turn to end$/ })).toBeDefined()

  await clock.advance(310_000)
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: /waits for the turn to end$/ })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: /cache already cold/ })).toBeDefined()
})

test('a turn.start that is rejected does not leave the session busy', async ($, on) => {
  const clock = mock.clock(on)
  const s = idleSession(on, { hit: true })
  on('turn.start', () => {
    throw new Error('refused')
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run(run('on'))
  await clock.advance(1_000)
  await $.turn.start({ turnId: 't1' } as never).catch(() => undefined)

  await clock.advance(271_000)
  expect(s.forks.length).toBe(1)
})

test('a fork from an earlier idle period does not show pinging for the new one', async ($, on) => {
  const clock = mock.clock(on)
  let during: { pinging: unknown; waiting: unknown } | undefined
  idleSession(on, {
    hit: true,
    clock,
    during: async () => {
      // Your own message starts a new idle period while the old period's fork is still out.
      // Re-arming runs a step to completion here, so no tick has to win a race to redraw the band.
      await $.prompt.submit({ text: 'hello' } as never)
      await $.command.run(run('on'))
      const band = await $.ui.mount(BAND)
      during = {
        pinging: await band.find({ type: 'Text', text: /pinging…$/ }),
        waiting: await band.find({ type: 'Text', text: /^keepalive 0\/24 · next ping/ }),
      }
    },
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run(run('on'))
  await clock.advance(270_000 + 5_000)
  await until(() => during !== undefined)

  expect(during?.pinging).toBeUndefined()
  expect(during?.waiting).toBeDefined()
})

test('a fork still pending past the cache lifetime shows the cache as cold', async ($, on) => {
  const clock = mock.clock(on)
  let during: unknown
  let isChecked = false
  idleSession(on, {
    hit: true,
    takesMs: 40_000,
    clock,
    during: async () => {
      during = await findLine($, /cache already cold/, clock)
      isChecked = true
    },
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run(run('on'))
  await clock.advance(270_000 + 41_000)
  await until(() => isChecked)

  expect(during).toBeDefined()
})

test('a main tool call that runs past ten minutes keeps the band on busy', async ($, on) => {
  const clock = mock.clock(on)
  const s = idleSession(on, { hit: true })
  let finish: () => void = () => undefined
  on('turn.start', (_$, e) => ({ turnId: e.turnId }) as never)
  on('tool.call', () => new Promise((resolve) => {
    finish = () => resolve({ result: 'done' } as never)
  }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run(run('on'))
  await clock.advance(1_000)
  await $.turn.start({ turnId: 't1' } as never)
  const call = $.tool.call({ tool: 'Bash', command: 'sleep 700' } as never)

  await clock.advance(660_000)
  expect(await findLine($, /waits for the turn to end$/)).toBeDefined()
  expect(s.forks.length).toBe(0)

  finish()
  await call
})

test('a fork from an earlier idle period that throws leaves the new period at 0 pings', async ($, on) => {
  const clock = mock.clock(on)
  on('turn.complete', () => ({ text: '' }))
  idleSession(on, {
    hit: true,
    throws: true,
    clock,
    during: async () => {
      // Your own message starts a new idle period, and its reply refreshes the cache, while the old fork is out.
      await $.prompt.submit({ text: 'hello' } as never)
      await $.turn.complete(COMPLETE)
    },
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run(run('on'))
  await clock.advance(270_000 + 5_000)

  expect(await findLine($, /^keepalive 0\/24 · next ping/, clock)).toBeDefined()
})

test('a main tool call whose hook finishes after turn.complete does not leave the band on busy', async ($, on) => {
  const clock = mock.clock(on)
  idleSession(on, { hit: true })
  let finish: () => void = () => undefined
  on('turn.start', (_$, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => new Promise((resolve) => {
    finish = () => resolve({ result: 'done' } as never)
  }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run(run('on'))
  await clock.advance(1_000)
  await $.turn.start({ turnId: 't1' } as never)
  const call = $.tool.call({ tool: 'Bash', command: 'sleep 5' } as never)
  await clock.advance(5_000)
  await $.turn.complete(COMPLETE)

  finish()
  await call
  await clock.advance(2_000)

  expect(await findLine($, /^keepalive 0\/24 · next ping/, clock)).toBeDefined()
})

test('a turn.complete with a tool still counted does not keep the next turn busy forever', async ($, on) => {
  const clock = mock.clock(on)
  idleSession(on, { hit: true })
  let finish: () => void = () => undefined
  on('turn.start', (_$, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => new Promise((resolve) => {
    finish = () => resolve({ result: 'done' } as never)
  }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run(run('on'))
  await clock.advance(1_000)
  await $.turn.start({ turnId: 't1' } as never)
  const call = $.tool.call({ tool: 'Bash', command: 'sleep 5' } as never)
  await clock.advance(1_000)
  await $.turn.complete(COMPLETE)

  // The next turn starts and dies; a stale tool count must not exempt it from the ten-minute limit.
  await $.turn.start({ turnId: 't2' } as never)
  await clock.advance(660_000)

  expect(await findLine($, /cache already cold/, clock)).toBeDefined()
  finish()
  await call
})

// A main turn whose request starts and ends while the ping's fork is pending.
function mainTurnDuringFork($: Parameters<TestBody>[0], on: Parameters<TestBody>[1]) {
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* () {
    return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: COMPLETE.usage } as const
  })

  return async () => {
    for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: OPUS, messageCount: 3 })) {
      void chunk
    }
    await $.turn.complete(COMPLETE)
  }
}

test('a main turn finishing during a pending fork that hits times the next ping from the turn\'s request start', async ($, on) => {
  const clock = mock.clock(on)
  const s = idleSession(on, { hit: true, takesMs: 10_000, clock, during: mainTurnDuringFork($, on) })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run(run('on'))
  // The ping starts at about 270s; the turn's request starts 10s later, when the fork returns.
  await clock.advance(270_000 + 15_000)
  expect(s.forks.length).toBe(1)

  // The next ping is due 270s after the turn's request started, not after the ping did.
  await clock.advance(260_000)
  expect(s.forks.length).toBe(1)
  await clock.advance(15_000)
  expect(s.forks.length).toBe(2)
})

test('a main turn finishing during a pending fork that misses does not leave the band on cold', async ($, on) => {
  const clock = mock.clock(on)
  idleSession(on, { hit: false, takesMs: 10_000, clock, during: mainTurnDuringFork($, on) })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run(run('on'))
  await clock.advance(270_000 + 15_000)

  expect(await findLine($, /^keepalive 1\/24 · .*next ping/, clock)).toBeDefined()
  expect(await (await $.ui.mount(BAND)).find({ type: 'Text', text: /cache already cold/ })).toBeUndefined()
})
