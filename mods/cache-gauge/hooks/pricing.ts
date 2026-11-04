import type { Snapshot } from '../types'

// Rates per model family, from Anthropic's pricing page (checked 2026-10-27).
// `input` is the list price per uncached input token; the calibration replaces it
// with what this session actually pays (Bedrock, enterprise pricing).
type Rates = { input: number; read: number }

const PER_MTOK = 1e-6
const FAMILIES: ReadonlyArray<readonly [RegExp, Rates]> = [
  [/(fable|mythos)-5-1/, { input: 10 * PER_MTOK, read: 0.025 }],
  [/(fable|mythos)-5/, { input: 10 * PER_MTOK, read: 0.1 }],
  [/opus-5-5/, { input: 4 * PER_MTOK, read: 0.05 }],
  [/opus/, { input: 5 * PER_MTOK, read: 0.1 }],
  [/sonnet-5-5/, { input: 2 * PER_MTOK, read: 0.05 }],
  [/sonnet-5/, { input: 2 * PER_MTOK, read: 0.1 }],
  [/sonnet/, { input: 3 * PER_MTOK, read: 0.1 }],
  [/haiku-5-5/, { input: 0.1 * PER_MTOK, read: 0.1 }],
  [/haiku/, { input: 1 * PER_MTOK, read: 0.1 }],
]
const DEFAULT_RATES: Rates = { input: 4 * PER_MTOK, read: 0.05 }

export const OUTPUT_RATIO = 5
export const EMA_ALPHA = 0.3

export type Ttl = '5m' | '1h'

const isTtl = (value: unknown): value is Ttl => value === '5m' || value === '1h'

// The cache lifetime Claude Code requests, by its documented precedence. Same function as
// cache-keepalive's (mods ship as separate folders, so it cannot be imported). It cannot see
// the billing type, so the unset default is 5m.
export function resolveTtl(input: {
  override?: unknown
  force5m?: string
  env?: string
  setting?: unknown
  enable1h?: string
}): Ttl {
  if (isTtl(input.override)) return input.override
  if (input.force5m === '1') return '5m'
  if (isTtl(input.env)) return input.env
  if (isTtl(input.setting)) return input.setting
  if (input.enable1h === '1') return '1h'

  return '5m'
}
export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export const ratesFor = (model: string): Rates =>
  FAMILIES.find(([pattern]) => pattern.test(model))?.[1] ?? DEFAULT_RATES

/** One model under two spellings: a reply's id may carry a provider prefix (`us.anthropic.`) that `/model`'s does not. */
export const isSameModel = (a: string | undefined, b: string | undefined): boolean =>
  a === b ||
  (typeof a === 'string' &&
    typeof b === 'string' &&
    a !== '' &&
    b !== '' &&
    (a.endsWith(`.${b}`) || b.endsWith(`.${a}`)))

export const writeRatio = (ttl: Ttl): number => (ttl === '1h' ? 2 : 1.25)

export const ttlMs = (ttl: Ttl): number => (ttl === '1h' ? 3_600_000 : 300_000)

/** The turn's tokens in units of one uncached input token. */
export const weightedUnits = (u: Usage, model: string, ttl: Ttl): number =>
  u.input_tokens +
  ratesFor(model).read * u.cache_read_input_tokens +
  writeRatio(ttl) * u.cache_creation_input_tokens +
  OUTPUT_RATIO * u.output_tokens

/** Next base rate: an EMA of Δcost / weighted units, or `prev` when the sample is unusable. */
export const calibrate = (prev: number | null, deltaUsd: number, units: number): number | null => {
  if (!(deltaUsd > 0) || !(units > 0)) {
    return prev
  }
  const sample = deltaUsd / units

  return prev === null ? sample : prev + EMA_ALPHA * (sample - prev)
}

/** Cost of re-sending `ctxTokens` on the next request, excluding its new input and response. */
export const nextCost = (ctxTokens: number, baseUsd: number, model: string, ttl: Ttl) => ({
  warm: ctxTokens * ratesFor(model).read * baseUsd,
  cold: ctxTokens * writeRatio(ttl) * baseUsd,
})

export const BAR_WIDTH = 10

// Eighth blocks, so a short bar still moves visibly with each step.
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

export const bar = (fraction: number, width = BAR_WIDTH): string => {
  const units = Math.round(Math.min(1, Math.max(0, fraction)) * width * 8)
  const full = Math.floor(units / 8)
  const part = EIGHTHS[units % 8]

  return '█'.repeat(full) + part + '░'.repeat(width - full - (part ? 1 : 0))
}

export type Level = 'success' | 'warning' | 'error'

/** Green below `warnAt`, yellow below `errorAt`, red from there. */
export const level = (fraction: number, warnAt: number, errorAt: number): Level =>
  fraction >= errorAt ? 'error' : fraction >= warnAt ? 'warning' : 'success'

export const tokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

export const usd = (n: number): string => (n < 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`)

export const countdown = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000))

  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * What the gauge shows at time `t`: the cache's lifetime left, whether it is warm, and the context's fill.
 * `pingedAt` is when a fork ping last read the cache (0 for none); the cache was last used at the later of that and the reply.
 */
export const gaugeState = (snap: Snapshot, ttl: Ttl, t: number, pingedAt = 0) => {
  // Fill toward where compaction runs (/autocompact moves it), else the model's window.
  const limit = snap.compactAt ?? snap.window
  const ctx = limit > 0 ? snap.ctxTokens / limit : 0
  const usedAt = snap.respondedAt === null ? null : Math.max(snap.respondedAt, pingedAt)
  const leftMs = usedAt === null ? 0 : usedAt + ttlMs(ttl) - Math.max(t, usedAt)
  const isWarm =
    usedAt !== null &&
    !snap.isCompacted &&
    isSameModel(snap.currentModel ?? snap.model, snap.model) &&
    leftMs > 0

  return { limit, ctx, leftMs, isWarm }
}
