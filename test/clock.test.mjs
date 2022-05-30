import assert from 'node:assert/strict'
import test from 'node:test'

import { backoffDelayMs, createVirtualClock } from '../src/clock.mjs'

test('a virtual clock only ever moves when it is told to', () => {
  const clock = createVirtualClock(0)

  assert.equal(clock.now(), 0)
  assert.equal(clock.now(), 0, 'reading the clock does not advance it')
  assert.equal(clock.elapsedMs(), 0)

  clock.advance(250)
  assert.equal(clock.now(), 250)
  assert.equal(clock.elapsedMs(), 250)
  clock.advance(0)
  assert.equal(clock.now(), 250, 'a zero advance is a no-op, not an error')
})

test('a clock started somewhere reports elapsed time, not absolute time', () => {
  const clock = createVirtualClock(1700000000000)

  clock.advance(500)
  assert.equal(clock.startMs, 1700000000000)
  assert.equal(clock.now(), 1700000000500)
  assert.equal(clock.elapsedMs(), 500)
})

test('a clock refuses a start or an advance that is not a non-negative integer', () => {
  assert.throws(() => createVirtualClock(-1), TypeError)
  assert.throws(() => createVirtualClock(1.5), TypeError)
  assert.throws(() => createVirtualClock('0'), TypeError)

  const clock = createVirtualClock(0)
  assert.throws(() => clock.advance(-1), TypeError)
  assert.throws(() => clock.advance(0.5), TypeError, 'a fractional advance would make timestamps depend on accumulation order')
  assert.throws(() => clock.advance(Number.NaN), TypeError)
})

test('the backoff sequence is exact integer arithmetic, not approximately exponential', () => {
  const policy = { backoffMs: 250, backoffFactor: 2, maxBackoffMs: 60000 }
  const sequence = [1, 2, 3, 4, 5].map((attempt) => backoffDelayMs(attempt, policy))

  assert.deepEqual(sequence, [250, 500, 1000, 2000, 4000])
})

test('the backoff cap is a ceiling the sequence stops at', () => {
  const policy = { backoffMs: 1000, backoffFactor: 10, maxBackoffMs: 5000 }
  const sequence = [1, 2, 3, 4].map((attempt) => backoffDelayMs(attempt, policy))

  assert.deepEqual(sequence, [1000, 5000, 5000, 5000])
})

test('a factor of one is a constant delay, and a zero base delay is no delay', () => {
  assert.deepEqual(
    [1, 2, 3].map((attempt) => backoffDelayMs(attempt, { backoffMs: 300, backoffFactor: 1, maxBackoffMs: 60000 })),
    [300, 300, 300],
  )
  assert.deepEqual(
    [1, 2, 3].map((attempt) => backoffDelayMs(attempt, { backoffMs: 0, backoffFactor: 2, maxBackoffMs: 60000 })),
    [0, 0, 0],
  )
})

test('backoff refuses an attempt number that is not a positive integer', () => {
  const policy = { backoffMs: 100, backoffFactor: 2, maxBackoffMs: 1000 }
  assert.throws(() => backoffDelayMs(0, policy), TypeError)
  assert.throws(() => backoffDelayMs(-1, policy), TypeError)
  assert.throws(() => backoffDelayMs(1.5, policy), TypeError)
})
