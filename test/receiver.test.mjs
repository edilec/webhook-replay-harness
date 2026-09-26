import assert from 'node:assert/strict'
import test from 'node:test'

import { SUPPORTED_TRANSPORTS, createInProcessReceiver, isRetryableStatus, isSuccessStatus } from '../src/receiver.mjs'

function receiver(overrides = {}) {
  return createInProcessReceiver({
    id: 'orders',
    transport: 'in-process',
    url: 'http://127.0.0.1:8787/hooks',
    defaultStatus: 200,
    dedupeStatus: 200,
    latencyMs: 0,
    dedupe: true,
    script: [],
    ...overrides,
  })
}

test('the only transport is the one that cannot open a socket', () => {
  assert.deepEqual(SUPPORTED_TRANSPORTS, ['in-process'])
})

test('an unscripted event gets the default status', () => {
  const mock = receiver({ defaultStatus: 202 })
  const result = mock.deliver({ eventId: 'evt_1', attempt: 1, atMs: 0 })

  assert.deepEqual(result, { status: 202, deduplicated: false, latencyMs: 0 })
  assert.deepEqual(mock.stats(), { handled: 1, deduplicated: 0, accepted: 0 })
})

test('a script gives one status per attempt, and its last entry repeats', () => {
  const mock = receiver({ script: [{ event: 'evt_1', statuses: [503, 500, 200], latencyMs: 7 }] })

  assert.equal(mock.deliver({ eventId: 'evt_1', attempt: 1, atMs: 0 }).status, 503)
  assert.equal(mock.deliver({ eventId: 'evt_1', attempt: 2, atMs: 10 }).status, 500)
  assert.equal(mock.deliver({ eventId: 'evt_1', attempt: 3, atMs: 20 }).status, 200)
  assert.equal(mock.deliver({ eventId: 'evt_1', attempt: 4, atMs: 30 }).status, 200, 'the last entry repeats rather than falling off the end')
  assert.equal(mock.deliver({ eventId: 'evt_1', attempt: 1, atMs: 40 }).latencyMs, 7)
})

test('dedupe keys on ids the receiver accepted, so a retry is not mistaken for a redelivery', () => {
  const mock = receiver({ script: [{ event: 'evt_1', statuses: [503, 200], latencyMs: 0 }] })

  assert.equal(mock.deliver({ eventId: 'evt_1', attempt: 1, atMs: 0 }).deduplicated, false)
  // The first attempt failed, so nothing was committed and attempt two is a
  // retry of the same delivery, not a duplicate of it.
  assert.equal(mock.deliver({ eventId: 'evt_1', attempt: 2, atMs: 10 }).deduplicated, false)

  mock.commit('evt_1')
  const third = mock.deliver({ eventId: 'evt_1', attempt: 1, atMs: 20 })
  assert.deepEqual(third, { status: 200, deduplicated: true, latencyMs: 0 })
  assert.deepEqual(mock.stats(), { handled: 2, deduplicated: 1, accepted: 1 })
})

test('a deduplicated delivery answers the dedupe status and consumes no script entry', () => {
  const mock = receiver({ dedupeStatus: 208, script: [{ event: 'evt_1', statuses: [200, 500], latencyMs: 0 }] })

  assert.equal(mock.deliver({ eventId: 'evt_1', attempt: 1, atMs: 0 }).status, 200)
  mock.commit('evt_1')
  assert.equal(mock.deliver({ eventId: 'evt_1', attempt: 1, atMs: 5 }).status, 208)
  assert.equal(mock.deliver({ eventId: 'evt_1', attempt: 2, atMs: 6 }).status, 208, 'the script is not advanced by a delivery that was never processed')
})

test('dedupe off means the receiver processes the same id again', () => {
  const mock = receiver({ dedupe: false })

  mock.deliver({ eventId: 'evt_1', attempt: 1, atMs: 0 })
  mock.commit('evt_1')
  assert.equal(mock.deliver({ eventId: 'evt_1', attempt: 1, atMs: 5 }).deduplicated, false)
  assert.equal(mock.stats().handled, 2)
})

test('the receiver log records every attempt it saw, in the order it saw them', () => {
  const mock = receiver({ script: [{ event: 'evt_1', statuses: [503, 200], latencyMs: 0 }] })

  mock.deliver({ eventId: 'evt_1', attempt: 1, atMs: 0 })
  mock.deliver({ eventId: 'evt_1', attempt: 2, atMs: 250 })
  mock.commit('evt_1')
  mock.deliver({ eventId: 'evt_1', attempt: 1, atMs: 300 })

  assert.deepEqual(mock.entries(), [
    { sequence: 1, eventId: 'evt_1', attempt: 1, atMs: 0, status: 503, deduplicated: false },
    { sequence: 2, eventId: 'evt_1', attempt: 2, atMs: 250, status: 200, deduplicated: false },
    { sequence: 3, eventId: 'evt_1', attempt: 1, atMs: 300, status: 200, deduplicated: true },
  ])
})

test('accepted ids come back in code-unit order, never in insertion order', () => {
  const mock = receiver()
  for (const id of ['a', 'Z', 'a_b', 'a-b', 'README']) mock.commit(id)

  assert.deepEqual(mock.accepted(), ['README', 'Z', 'a', 'a-b', 'a_b'])
})

test('the retryable set is closed and documented, not "anything that is not a success"', () => {
  for (const status of [200, 201, 202, 204, 299]) {
    assert.equal(isSuccessStatus(status), true, `${status} accepts the event`)
    assert.equal(isRetryableStatus(status), false)
  }
  for (const status of [408, 425, 429, 500, 503, 599]) {
    assert.equal(isRetryableStatus(status), true, `${status} is worth another attempt`)
    assert.equal(isSuccessStatus(status), false)
  }
  for (const status of [300, 400, 401, 403, 404, 410, 422]) {
    assert.equal(isRetryableStatus(status), false, `${status} will never become a delivery`)
    assert.equal(isSuccessStatus(status), false)
  }
})
