import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { exitCodeFor, replayPlan } from '../src/index.mjs'

const RECEIVER_URL = 'http://127.0.0.1:8787/hooks/orders'

/**
 * `incomplete` without its backstop.
 *
 * Every existing test for these rules replays nothing successfully, so
 * `no-events-replayed` fires as well and sets the same flag a second time. That
 * makes each of them pass whether or not the rule under test sets the flag at
 * all: delete the assignment and the run is still `incomplete`, because the
 * empty replay said so.
 *
 * Each plan below therefore delivers one event to a verdict *first*. With
 * `checked` at one there is no second rule to set the flag, so the status is
 * decided solely by the assignment under test -- and dropping it turns a
 * documented `incomplete` / exit 2 into `fail` / exit 1, which these
 * assertions catch.
 */

async function withBase(body) {
  const base = await mkdtemp(join(tmpdir(), 'webhook-replay-harness-backstop-'))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

function plan(overrides = {}) {
  const { receiver, ...rest } = overrides
  return {
    receiver: { id: 'orders', url: RECEIVER_URL, ...receiver },
    events: [{ id: 'evt_ok', payload: { ok: true } }],
    ...rest,
  }
}

/** Every rule the report raised, deduplicated, in code-unit order. */
function raised(report) {
  return [...new Set(report.findings.map((finding) => finding.ruleId))].sort()
}

test('an events root that will not resolve is incomplete even when another event was delivered', async () => {
  await withBase(async (base) => {
    const report = await replayPlan(
      plan({
        eventsRoot: 'nowhere',
        events: [{ id: 'evt_ok', payload: {} }, { id: 'evt_file', file: 'order.json' }],
      }),
      { baseDir: base },
    )

    assert.deepEqual(raised(report), ['event-file-unreadable'], 'no no-events-replayed to set the flag for it')
    assert.equal(report.summary.checked, 1, 'one event did reach a verdict')
    assert.equal(report.status, 'incomplete')
    assert.equal(exitCodeFor(report), 2)
    assert.equal(report.summary.delivered, 1)
    assert.equal(report.summary.skipped, 1)
  })
})

test('a fixture path that cannot be read is incomplete even when another event was delivered', async () => {
  await withBase(async (base) => {
    await mkdir(join(base, 'events', 'order.json'), { recursive: true })

    const report = await replayPlan(
      plan({
        eventsRoot: 'events',
        events: [{ id: 'evt_ok', payload: {} }, { id: 'evt_dir', file: 'order.json' }],
      }),
      { baseDir: base },
    )

    assert.deepEqual(raised(report), ['event-file-unreadable'])
    assert.equal(report.findings[0].message.includes('EISDIR'), true, 'the read failed, not the resolution')
    assert.equal(report.summary.checked, 1)
    assert.equal(report.status, 'incomplete')
    assert.equal(exitCodeFor(report), 2)
    assert.equal(report.summary.skipped, 1)
  })
})

test('virtual time already spent stops the next event, and that is incomplete', async () => {
  const report = await replayPlan(
    plan({
      receiver: { latencyMs: 150 },
      events: [{ id: 'evt_ok', payload: {} }, { id: 'evt_late', payload: {} }],
    }),
    { limits: { maxVirtualMs: 100 } },
  )

  assert.deepEqual(raised(report), ['limit-virtual-time-exceeded'])
  assert.equal(report.findings[0].message.startsWith('Virtual time reached 150ms'), true, 'the bound was hit before the event, not inside its backoff')
  assert.equal(report.findings[0].location.pointer, '/events/1')
  assert.equal(report.summary.checked, 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
  assert.equal(report.summary.skipped, 1)
})

test('a backoff that would pass the virtual time bound is incomplete, not a failed delivery', async () => {
  const report = await replayPlan(
    plan({
      receiver: { script: [{ event: 'evt_slow', statuses: [503] }] },
      delivery: { maxAttempts: 3, backoffMs: 250, backoffFactor: 2, maxBackoffMs: 60000 },
      events: [{ id: 'evt_ok', payload: {} }, { id: 'evt_slow', payload: {} }],
    }),
    { limits: { maxVirtualMs: 100 } },
  )

  assert.deepEqual(raised(report), ['limit-virtual-time-exceeded'])
  assert.equal(report.findings[0].message.startsWith('Waiting 250ms before attempt 2'), true, 'the bound was hit inside the retry loop')
  assert.equal(report.summary.checked, 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
  assert.equal(report.summary.virtualElapsedMs, 0, 'the clock never passed the budget')
  assert.equal(report.replay.deliveries[1].outcome, 'stopped')
})

test('the total attempt bound stops the replay, and that is incomplete', async () => {
  const report = await replayPlan(
    plan({ events: [{ id: 'evt_ok', payload: {} }, { id: 'evt_next', payload: {} }] }),
    { limits: { maxTotalAttempts: 1 } },
  )

  assert.deepEqual(raised(report), ['limit-total-attempts-exceeded'])
  assert.equal(report.summary.attempts, 1)
  assert.equal(report.summary.checked, 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
  assert.equal(report.replay.deliveries[1].outcome, 'stopped')
})

/**
 * The same shape one layer out: the bound stops the replay before the events
 * are even ordered, and one event still reached a verdict.
 */
test('the events bound is incomplete even when every replayed event was delivered', async () => {
  const report = await replayPlan(
    plan({ events: [{ id: 'evt_ok', payload: {} }, { id: 'evt_cut', payload: {} }] }),
    { limits: { maxEvents: 1 } },
  )

  assert.deepEqual(raised(report), ['limit-events-exceeded'])
  assert.equal(report.summary.checked, 1)
  assert.equal(report.summary.delivered, 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
})
