import { expect, test } from 'claude-code/testing'

import { clock, describe, plan, readRatio, resolveTtl } from './budget'

const open = { factor: 1, hardCap: 1000, maxHours: 1000, intervalPercent: 90 }

test('readRatio_shouldFollowModelPricing_whenModelKnown', () => {
  expect(readRatio('global.anthropic.claude-fable-5-1')).toBe(0.025)
  expect(readRatio('global.anthropic.claude-opus-5-5')).toBe(0.05)
  expect(readRatio('global.anthropic.claude-sonnet-5-5')).toBe(0.1)
  expect(readRatio(undefined)).toBe(0.1)
})

test('plan_shouldReturnFiveMinuteBreakEven_whenTtlIs5m', () => {
  expect(plan('claude-sonnet-5-5', '5m', open).limit).toBe(11)
  expect(plan('claude-opus-5-5', '5m', open).limit).toBe(24)
  expect(plan('claude-fable-5-1', '5m', open).limit).toBe(49)
  expect(plan('claude-sonnet-5-5', '5m', open).intervalMs).toBe(270_000)
})

test('plan_shouldReturnOneHourBreakEven_whenTtlIs1h', () => {
  expect(plan('claude-sonnet-5-5', '1h', open).limit).toBe(19)
  expect(plan('claude-opus-5-5', '1h', open).limit).toBe(39)
  expect(plan('claude-sonnet-5-5', '1h', open).intervalMs).toBe(3_240_000)
})

test('plan_shouldRespectCapsAndFactor_whenSet', () => {
  expect(plan('claude-fable-5-1', '5m', { ...open, hardCap: 40 }).limit).toBe(40)
  expect(plan('claude-opus-5-5', '5m', { ...open, factor: 0.5 }).limit).toBe(12)
  expect(plan('claude-sonnet-5-5', '5m', { ...open, factor: 0 }).limit).toBe(1)
  expect(plan('claude-fable-5-1', '1h', { ...open, maxHours: 4 }).limit).toBe(4)
})

test('resolveTtl_shouldFollowPrecedence_whenSeveralControlsSet', () => {
  expect(resolveTtl({})).toEqual({ ttl: '5m', source: 'default (assumed)' })
  expect(resolveTtl({ enable1h: '1' }).ttl).toBe('1h')
  expect(resolveTtl({ enable1h: '1', setting: '5m' }).ttl).toBe('5m')
  expect(resolveTtl({ setting: '5m', env: '1h' }).ttl).toBe('1h')
  expect(resolveTtl({ env: '1h', force5m: '1' }).ttl).toBe('5m')
  expect(resolveTtl({ force5m: '1', override: '1h' }).ttl).toBe('1h')
})

test('clock_shouldFormatMinutesAndHours_whenGivenMilliseconds', () => {
  expect(clock(105_000)).toBe('1:45')
  expect(clock(-5)).toBe('0:00')
  expect(clock(5_400_000)).toBe('1h30m')
})

test('describe_shouldNameTheNextPingAndWarmTime_whenWaiting', () => {
  const line = describe({ kind: 'waiting', pings: 3, limit: 24, nextPingMs: 130_000, warmForMs: 5_640_000 })
  expect(line.color).toBe('success')
  expect(line.text).toBe('keepalive 3/24 · next ping 2:10 · keeps warm ~1h34m')
})

test('describe_shouldWarnInYellow_whenBudgetIsUsed', () => {
  const line = describe({ kind: 'spent', pings: 24, limit: 24, lapsesInMs: 252_000 })
  expect(line.color).toBe('warning')
  expect(line.text).toBe('keepalive 24/24 · budget used, cache lapses in 4:12')
})
