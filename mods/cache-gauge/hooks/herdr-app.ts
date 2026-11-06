import type { Snapshot } from '../types'
import { shortModel } from './herdr'
import { isCacheInvalidated, lastUsedAt, ttlMs } from './pricing'
import type { Ttl } from './pricing'

// hc sets HC_TERMINAL_ID in every terminal it starts: `t1`, or `mac/t7` for a remote machine.
// Addresses past t19 carry lowercase letters (`t1b`, `t1h`).
const TERMINAL_ID = /^([A-Za-z0-9._-]+\/)?t[0-9a-z]+$/

/** The file system and environment the reporter touches; the mod builds it from `$`, a test from fakes. */
export type AppIo = {
  env: (name: 'HOME' | 'HC_TERMINAL_ID') => Promise<string | undefined>
  /** Creates the directory and its parents, the directory itself readable by the user only. */
  mkdir: (dir: string) => Promise<void>
  write: (path: string, text: string) => Promise<void>
  /** Replaces `to` with `from` in one step. */
  rename: (from: string, to: string) => Promise<void>
  /** Removes the file; a missing file is not an error. */
  remove: (path: string) => Promise<void>
  /** The absolute path of an executable on PATH, or undefined when it is not found. */
  which: (name: 'herdr-app') => Promise<string | undefined>
}

const quote = (v: string) => `'${v.replaceAll("'", "'\\''")}'`

/**
 * Writes the model and cache warmth to `~/.cache/cache-gauge/herdr-app/<terminal>.json` for the Herdr app mod, when the
 * session runs in an hc terminal. Off elsewhere, and a failing file system never reaches the gauge.
 */
export const createHerdrApp = (getTtl: () => Ttl) => {
  let io: AppIo | null = null
  let terminal = ''
  let sessionId = ''
  let dir = ''
  let isDirMade = false
  let bin = ''
  // The last payload written, without its timestamp.
  let sent: string | null = null
  // One operation at a time, so a write and the delete at the end land in order.
  let queue: Promise<unknown> = Promise.resolve()

  const enqueue = (job: () => Promise<void>) => {
    queue = queue.then(job).catch(() => {})
  }
  const file = () => `${dir}/${terminal.replaceAll('/', '_')}.json`

  return {
    get isOn() {
      return terminal !== ''
    },

    /**
     * A shell command for a notification click that focuses this terminal's agent in the Herdr app, usable from a bare
     * environment (absolute path, every value quoted); empty when the reporter is off or herdr-app was not found.
     */
    get focusCommand() {
      return terminal !== '' && bin.startsWith('/') ? `${quote(bin)} do agent.focus --terminal ${quote(terminal)}` : ''
    },

    /** Reads the environment; the reporter stays off unless HC_TERMINAL_ID is a valid terminal id and HOME is known. */
    async detect(fileIo: AppIo, id: string) {
      io = fileIo
      sessionId = id
      terminal = ''
      bin = ''
      isDirMade = false
      sent = null
      try {
        const candidate = ((await io.env('HC_TERMINAL_ID')) ?? '').trim()
        const home = ((await io.env('HOME')) ?? '').trim()
        if (TERMINAL_ID.test(candidate) &&home.startsWith('/')) {
          terminal = candidate
          dir = `${home.replace(/\/+$/, '')}/.cache/cache-gauge/herdr-app`
        }
      } catch {
        terminal = ''
      }
      if (terminal !== '') {
        try {
          bin = ((await io.which('herdr-app')) ?? '').trim()
        } catch {
          bin = ''
        }
      }
    },

    /** Removes the file, for a session that ends; resolves once the removal has run. */
    async clear() {
      if (terminal === '' || io === null) {
        return
      }
      const fileIo = io
      sent = null
      enqueue(() => fileIo.remove(file()))
      await queue
    },

    /** Writes what changed since the last report; `t` is the clock's now, `pingedAt` the last fork ping (0 for none). */
    report(snap: Snapshot | null, t: number, pingedAt = 0) {
      if (terminal === '' || io === null || snap === null) {
        return
      }
      const fileIo = io
      const model = snap.currentModel ?? snap.model
      const body = {
        v: 1,
        terminal,
        session_id: sessionId,
        model,
        model_short: shortModel(model),
        last_assistant_ms: isCacheInvalidated(snap) ? 0 : (lastUsedAt(snap, pingedAt) ?? 0),
        ttl_s: ttlMs(getTtl()) / 1000,
      }
      const key = JSON.stringify(body)
      if (key === sent) {
        return
      }
      sent = key
      const text = JSON.stringify({ ...body, updated_ms: t })
      const path = file()
      enqueue(async () => {
        try {
          if (!isDirMade) {
            await fileIo.mkdir(dir)
            isDirMade = true
          }
          // The reader never sees a half-written file: the temp name does not end in .json.
          await fileIo.write(`${path}.tmp`, text)
          await fileIo.rename(`${path}.tmp`, path)
        } catch (error) {
          // Try again on the next report.
          sent = null
          throw error
        }
      })
    },
  }
}
