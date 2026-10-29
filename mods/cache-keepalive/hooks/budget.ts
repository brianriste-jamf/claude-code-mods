import type { KeepaliveView } from '../types'

export type Ttl = '5m' | '1h'

const TTL_MS: Record<Ttl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }

// Cache-write price as a multiple of the base input price.
const WRITE: Record<Ttl, number> = { '5m': 1.25, '1h': 2 }

export type PlanOptions = {
  factor: number
  hardCap: number
  maxHours: number
  intervalPercent: number
}

export type Plan = { ttl: Ttl; ttlMs: number; intervalMs: number; limit: number }

const isTtl = (value: unknown): value is Ttl => value === '5m' || value === '1h'

// Cache-read price as a fraction of the base input price, by model id.
export function readRatio(model: string | undefined): number {
  const id = (model ?? '').toLowerCase()

  if (id.includes('fable') || id.includes('mythos')) return 0.025
  if (id.includes('opus-5-5') || id.includes('opus-5.5')) return 0.05
  if (id.includes('sonnet-5-5') || id.includes('sonnet-5.5')) return 0.05

  return 0.1
}

// The cache lifetime Claude Code requests, by its documented precedence. It cannot
// see the billing type, so the unset default is the safe 5m: a 1h cache just gets
// pinged more often than it needs.
export function resolveTtl(input: {
  override?: unknown
  force5m?: string
  env?: string
  setting?: unknown
  enable1h?: string
}): { ttl: Ttl; source: string } {
  if (isTtl(input.override)) return { ttl: input.override, source: 'mod option' }
  if (input.force5m === '1') return { ttl: '5m', source: 'FORCE_PROMPT_CACHING_5M' }
  if (isTtl(input.env)) return { ttl: input.env, source: 'CLAUDE_CODE_PROMPT_CACHE_TTL' }
  if (isTtl(input.setting)) return { ttl: input.setting, source: 'promptCacheTtl setting' }
  if (input.enable1h === '1') return { ttl: '1h', source: 'ENABLE_PROMPT_CACHING_1H' }

  return { ttl: '5m', source: 'default (assumed)' }
}

// Pings are spaced at a share of the lifetime, and capped where a lapsed cache would
// have been cheaper: one miss costs (write - read) x context, one ping read x context.
export function plan(model: string | undefined, ttl: Ttl, options: PlanOptions): Plan {
  const ratio = readRatio(model)
  const ttlMs = TTL_MS[ttl]
  const percent = Math.min(95, Math.max(50, options.intervalPercent))
  const intervalMs = Math.round((ttlMs * percent) / 100)
  // The epsilon absorbs float error (1.2 / 0.05 is 23.999...).
  const breakEven = Math.floor(((WRITE[ttl] - ratio) / ratio) * options.factor + 1e-9)
  const byTime = Math.floor((options.maxHours * 3_600_000) / intervalMs)

  return { ttl, ttlMs, intervalMs, limit: Math.max(1, Math.min(breakEven, options.hardCap, byTime)) }
}

export function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = String(total % 60).padStart(2, '0')

  if (minutes >= 60) return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`

  return `${minutes}:${seconds}`
}

export const money = (usd: number): string => (usd < 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`)

/** The band line for an armed keep-alive: glyph colour and text. */
export function describe(v: Exclude<KeepaliveView, { kind: 'off' }>): { color: 'success' | 'warning' | undefined; text: string } {
  const head = `keepalive ${v.pings}/${v.limit}${v.spentUsd > 0 ? ` · ${money(v.spentUsd)} spent` : ''}`

  switch (v.kind) {
    case 'waiting':
      return { color: 'success', text: `${head} · next ping ${clock(v.nextPingMs)} · keeps warm ~${clock(v.warmForMs)}` }
    case 'spent':
      return { color: 'warning', text: `${head} · budget used, cache lapses in ${clock(v.lapsesInMs)}` }
    case 'busy':
      return { color: 'success', text: `${head} · waits for the turn to end` }
    case 'cold':
      return { color: undefined, text: `${head} · cache already cold, nothing to keep warm` }
  }
}
