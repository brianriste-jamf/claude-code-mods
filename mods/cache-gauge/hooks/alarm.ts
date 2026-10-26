import type { AudioClip } from 'claude-code'

/** The warning notification fires this long before the cache goes cold. */
export const NOTIFY_MS = 60_000
/** The sound starts this long before, so the bundled 15 s clip ends as the cache does. */
export const SOUND_MS = 15_000

export type AlarmMode = 'off' | 'notify' | 'countdown'
export type Phase = 'none' | 'notify' | 'sound'

export const alarmMode = (option: unknown): AlarmMode => (option === 'off' || option === 'countdown' ? option : 'notify')

/** Only an idle cache counts down: mid-turn every request restarts the lifetime. */
export const alarmPhase = (leftMs: number, isIdle: boolean): Phase => {
  if (!isIdle || leftMs <= 0 || leftMs > NOTIFY_MS) {
    return 'none'
  }

  return leftMs <= SOUND_MS ? 'sound' : 'notify'
}

const MIME: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', aif: 'audio/aiff', aiff: 'audio/aiff' }

/** What the alarm does to the outside, spelled with `$` at the call site: the engine allows `$` nowhere else. */
export type AlarmIo = {
  /** `isFirst`: the period's first notification, the only one with a toast and a sound; the others replace it in place. */
  notify: (body: string, isFirst: boolean) => void
  /** Removes the period's notification. */
  clear: () => void
  play: (clip: AudioClip, signal: AbortSignal) => Promise<void>
  readBytes: (path: string) => Promise<string>
}

/** A user's own file, read as bytes; the bundled clip when the path is empty or unreadable. */
async function clipFor(io: AlarmIo, file: string): Promise<AudioClip> {
  const bundled: AudioClip = { asset: 'sounds/countdown.mp3' }
  const mime = MIME[file.slice(file.lastIndexOf('.') + 1).toLowerCase()]
  if (file === '' || mime === undefined) {
    return bundled
  }
  try {
    return { base64: await io.readBytes(file), mime }
  } catch {
    return bundled
  }
}

/** The next message's price, already formatted by the caller; null before the session has a snapshot. */
export type Prices = { warm: string; cold: string } | null

/** `left` is the human label of the time left: `1m` or `15s`. */
export const endingText = (left: string, prices: Prices) =>
  prices === null
    ? `Cache ending in ${left}. Reply to keep it warm.`
    : `Cache ending in ${left}. Reply to keep your next message at ${prices.warm}; cold it costs ${prices.cold}.`

export const coldText = (prices: Prices) =>
  prices === null
    ? 'Cache is cold. The next message re-sends the full context.'
    : `Cache is cold. Your next message costs ${prices.cold} (warm: ${prices.warm}).`

/**
 * For an idle cache: a notification at 1 min left, replaced at 15 s and again when it goes cold; in `countdown` mode a clip from 15 s.
 * `tick` is called every second; a new `warmUntil` (any reply) is a new period, and `reset` ends the old one.
 */
export const createAlarm = (mode: AlarmMode, file: string) => {
  let warnedFor = 0
  let updatedFor = 0
  let coldFor = 0
  let soundedFor = 0
  let stop: AbortController | null = null
  let shown: AlarmIo | null = null

  const silence = () => {
    stop?.abort()
    stop = null
  }

  return {
    silence,

    /** A message or request ends the period: stop the clip and take the notification down. */
    reset() {
      silence()
      shown?.clear()
      shown = null
    },

    tick(io: AlarmIo, t: number, warmUntil: number, isIdle: boolean, prices: Prices) {
      if (mode === 'off') {
        return
      }
      const leftMs = warmUntil - t
      // Only a period that warned goes on to say it went cold: a machine that wakes past the expiry stays quiet.
      if (isIdle && leftMs <= 0 && warmUntil > 0 && warnedFor === warmUntil && coldFor !== warmUntil) {
        coldFor = warmUntil
        io.notify(coldText(prices), false)

        return
      }
      const phase = alarmPhase(leftMs, isIdle)
      if (phase === 'none') {
        silence()

        return
      }
      shown = io
      if (warnedFor !== warmUntil) {
        warnedFor = warmUntil
        // Waking inside the last 15 s starts at the 15 s message.
        updatedFor = phase === 'sound' ? warmUntil : updatedFor
        io.notify(endingText(phase === 'sound' ? '15s' : '1m', prices), true)
      } else if (phase === 'sound' && updatedFor !== warmUntil) {
        updatedFor = warmUntil
        io.notify(endingText('15s', prices), false)
      }
      if (phase === 'sound' && mode === 'countdown' && soundedFor !== warmUntil) {
        soundedFor = warmUntil
        stop = new AbortController()
        const { signal } = stop
        void clipFor(io, file)
          .then(clip => io.play(clip, signal))
          .catch(() => {})
      }
    },
  }
}
