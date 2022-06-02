import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createVirtualClock, replayPlan } from '../src/index.mjs'

const RECEIVER_URL = 'http://127.0.0.1:8787/hooks/orders'

function plan(overrides = {}) {
  const { receiver, ...rest } = overrides
  return {
    receiver: { id: 'orders', url: RECEIVER_URL, ...receiver },
    events: [{ id: 'evt_1', payload: { ok: true } }],
    ...rest,
  }
}

function raised(report) {
  return [...new Set(report.findings.map((finding) => finding.ruleId))].sort()
}

async function withBase(body) {
  const base = await mkdtemp(join(tmpdir(), 'webhook-replay-harness-'))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

test('a retry advances virtual time by the exact backoff sequence', async () => {
  const report = await replayPlan(plan({
    receiver: { script: [{ event: 'evt_1', statuses: [503, 500, 200] }] },
    delivery: { maxAttempts: 3, backoffMs: 250, backoffFactor: 2, maxBackoffMs: 60000 },
  }))

  assert.deepEqual(report.replay.receiverLog.map((entry) => entry.atMs), [0, 250, 750])
  assert.deepEqual(report.replay.receiverLog.map((entry) => entry.status), [503, 500, 200])
  assert.equal(report.summary.virtualElapsedMs, 750)
  assert.equal(report.summary.retries, 2)
  assert.deepEqual(raised(report), ['delivery-retried'])
  assert.equal(report.status, 'pass', 'an event that was eventually accepted is not a failure')
})

test('scripted latency advances the clock too, so an attempt is not instantaneous', async () => {
  const report = await replayPlan(plan({
    receiver: { script: [{ event: 'evt_1', statuses: [503, 200], latencyMs: 40 }] },
    delivery: { maxAttempts: 2, backoffMs: 100, backoffFactor: 1, maxBackoffMs: 1000 },
  }))

  // attempt 1 at 0 takes 40ms, then 100ms of backoff, so attempt 2 starts at 140.
  assert.deepEqual(report.replay.receiverLog.map((entry) => entry.atMs), [0, 140])
  assert.equal(report.summary.virtualElapsedMs, 180)
})

test('the backoff cap applies inside a real replay, not only in the arithmetic', async () => {
  const report = await replayPlan(plan({
    receiver: { script: [{ event: 'evt_1', statuses: [503, 503, 503, 200] }] },
    delivery: { maxAttempts: 4, backoffMs: 1000, backoffFactor: 10, maxBackoffMs: 2000 },
  }))

  assert.deepEqual(report.replay.receiverLog.map((entry) => entry.atMs), [0, 1000, 3000, 5000])
})

test('a non-retryable status stops after one attempt and fails the run', async () => {
  const report = await replayPlan(plan({ receiver: { script: [{ event: 'evt_1', statuses: [410, 200] }] } }))

  assert.deepEqual(raised(report), ['delivery-rejected-permanently'])
  assert.equal(report.summary.attempts, 1, 'a 410 will never become a delivery, so the budget is not burned on it')
  assert.equal(report.replay.deliveries[0].outcome, 'rejected')
  assert.equal(report.status, 'fail')
})

test('an exhausted retry budget is a failure, and the report says how much virtual time it cost', async () => {
  const report = await replayPlan(plan({
    receiver: { script: [{ event: 'evt_1', statuses: [500] }] },
    delivery: { maxAttempts: 3, backoffMs: 200, backoffFactor: 3, maxBackoffMs: 60000 },
  }))

  assert.deepEqual(raised(report), ['delivery-exhausted-retries'])
  assert.equal(report.summary.attempts, 3)
  assert.equal(report.replay.deliveries[0].outcome, 'exhausted')
  assert.equal(report.findings[0].evidence, 'virtual time spent 800ms')
  assert.equal(report.status, 'fail')
})

test('a duplicate id the receiver deduplicates is reported without failing the run', async () => {
  const report = await replayPlan(plan({
    receiver: { dedupe: true },
    events: [{ id: 'evt_1', payload: {} }, { id: 'evt_1', payload: {} }],
  }))

  assert.deepEqual(raised(report), ['duplicate-event-id-deduplicated'])
  assert.equal(report.summary.delivered, 1)
  assert.equal(report.summary.deduplicated, 1)
  assert.deepEqual(report.replay.receiverLog.map((entry) => entry.deduplicated), [false, true])
  assert.equal(report.status, 'pass')
})

test('a duplicate id the receiver does not deduplicate is a failure', async () => {
  const report = await replayPlan(plan({
    receiver: { dedupe: false },
    events: [{ id: 'evt_1', payload: {} }, { id: 'evt_1', payload: {} }],
  }))

  assert.deepEqual(raised(report), ['duplicate-event-id-redelivered'])
  assert.equal(report.summary.delivered, 2, 'the receiver really did process it twice')
  assert.equal(report.status, 'fail')
})

test('a duplicate whose first delivery was never accepted is a redelivery, not a dedupe', async () => {
  const report = await replayPlan(plan({
    receiver: { dedupe: true, script: [{ event: 'evt_1', statuses: [410, 200] }] },
    events: [{ id: 'evt_1', payload: {} }, { id: 'evt_1', payload: {} }],
  }))

  assert.deepEqual(raised(report), ['delivery-rejected-permanently', 'duplicate-event-id-redelivered'])
  assert.equal(report.replay.deliveries[1].deduplicated, false, 'nothing was committed, so there was nothing to deduplicate against')
})

test('a retried event is not mistaken for a duplicate of itself', async () => {
  const report = await replayPlan(plan({
    receiver: { dedupe: true, script: [{ event: 'evt_1', statuses: [503, 200] }] },
    delivery: { maxAttempts: 2, backoffMs: 10, backoffFactor: 1, maxBackoffMs: 100 },
  }))

  assert.deepEqual(raised(report), ['delivery-retried'])
  assert.equal(report.replay.deliveries[0].deduplicated, false)
  assert.equal(report.summary.deduplicated, 0)
})

/**
 * The safety property, checked at the point it matters most: the refusal comes
 * before anything is opened. The fixture file named here does not exist, so if
 * the body were loaded first the report would say "unreadable" and go
 * incomplete instead of refusing the target.
 */
test('an external target is refused before its fixture file is even opened', async () => {
  await withBase(async (base) => {
    await mkdir(join(base, 'events'))
    const report = await replayPlan(
      plan({
        eventsRoot: 'events',
        events: [{ id: 'evt_1', target: 'https://hooks.example.com/inbound', file: 'missing.json' }],
      }),
      { baseDir: base },
    )

    assert.deepEqual(raised(report), ['target-host-not-allowed'])
    assert.equal(report.status, 'fail', 'a refusal is a verdict this harness reached, not evidence it failed to get')
    assert.equal(report.summary.refused, 1)
    assert.equal(report.summary.attempts, 0)
    assert.deepEqual(report.replay.receiverLog, [], 'nothing reached the receiver')
    assert.equal(report.replay.deliveries[0].attempts, 0)
  })
})

test('a fixture reached through a symlinked events root is still replayed', async () => {
  await withBase(async (base) => {
    await mkdir(join(base, 'real-events'))
    await writeFile(join(base, 'real-events', 'order.json'), JSON.stringify({ orderId: 'A-1' }))
    await symlink(join(base, 'real-events'), join(base, 'link-events'))

    const report = await replayPlan(
      plan({ eventsRoot: 'link-events', events: [{ id: 'evt_1', file: 'order.json' }] }),
      { baseDir: base },
    )

    assert.deepEqual(report.findings, [], 'refusing a file genuinely inside a symlinked root is a bug too')
    assert.equal(report.status, 'pass')
    assert.equal(report.replay.deliveries[0].source, 'link-events/order.json')
  })
})

test('a symlink out of the events root is refused unread, and its contents stay out of the report', async () => {
  await withBase(async (base) => {
    await mkdir(join(base, 'events'))
    await mkdir(join(base, 'outside'))
    await writeFile(join(base, 'outside', 'secret.json'), JSON.stringify({ marker: 'OUTSIDE_CONTENT_MARKER' }))
    await symlink(join(base, 'outside', 'secret.json'), join(base, 'events', 'escape.json'))

    const report = await replayPlan(
      plan({ eventsRoot: 'events', events: [{ id: 'evt_1', file: 'escape.json' }] }),
      { baseDir: base },
    )

    assert.deepEqual(raised(report), ['event-file-outside-root'])
    assert.equal(report.status, 'fail')
    assert.equal(JSON.stringify(report).includes('OUTSIDE_CONTENT_MARKER'), false)
    assert.equal(report.summary.attempts, 0)
  })
})

test('a fixture file that cannot be read, decoded or parsed makes the run incomplete', async () => {
  await withBase(async (base) => {
    await mkdir(join(base, 'events'))
    await writeFile(join(base, 'events', 'bad-bytes.json'), Uint8Array.from([0x7b, 0xff, 0xfe, 0x7d]))
    await writeFile(join(base, 'events', 'bad-json.json'), '{ nope')

    for (const [file, ruleId] of [
      ['missing.json', 'event-file-unreadable'],
      ['bad-bytes.json', 'event-file-not-utf8'],
      ['bad-json.json', 'event-file-not-json'],
    ]) {
      const report = await replayPlan(
        plan({
          eventsRoot: 'events',
          events: [{ id: 'evt_ok', payload: {} }, { id: 'evt_bad', file }],
        }),
        { baseDir: base },
      )

      assert.deepEqual(raised(report), [ruleId], `${file} must raise ${ruleId}`)
      assert.equal(report.status, 'incomplete', 'evidence nobody obtained is never a verdict')
      assert.equal(report.summary.checked, 1)
      assert.equal(report.summary.skipped, 1)
    }
  })
})

test('an events root that does not resolve is reported once and nothing file-backed is replayed', async () => {
  await withBase(async (base) => {
    const report = await replayPlan(
      plan({ eventsRoot: 'nowhere', events: [{ id: 'evt_1', file: 'a.json' }] }),
      { baseDir: base },
    )

    assert.deepEqual(raised(report), ['event-file-unreadable', 'no-events-replayed'])
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.skipped, 1)
  })
})

test('a plan that declares an events root but is replayed without a base directory is a configuration error', async () => {
  await assert.rejects(
    () => replayPlan(plan({ eventsRoot: 'events', events: [{ id: 'evt_1', file: 'a.json' }] })),
    TypeError,
  )
})

test('the maxEvents limit stops the replay and names what was not replayed', async () => {
  const report = await replayPlan(
    plan({ events: [{ id: 'evt_1', payload: {} }, { id: 'evt_2', payload: {} }, { id: 'evt_3', payload: {} }] }),
    { limits: { maxEvents: 2 } },
  )

  assert.deepEqual(raised(report), ['limit-events-exceeded'])
  assert.equal(report.findings[0].evidence, 'first event not replayed: evt_3')
  assert.equal(report.summary.checked, 2)
  assert.equal(report.summary.skipped, 1)
  assert.equal(report.status, 'incomplete', 'a bound that was hit is never a pass')
})

test('the maxTotalAttempts limit stops the replay rather than truncating it quietly', async () => {
  const report = await replayPlan(
    plan({
      receiver: { script: [{ event: 'evt_1', statuses: [500] }, { event: 'evt_2', statuses: [500] }] },
      delivery: { maxAttempts: 3, backoffMs: 10, backoffFactor: 1, maxBackoffMs: 100 },
      events: [{ id: 'evt_1', payload: {} }, { id: 'evt_2', payload: {} }],
    }),
    { limits: { maxTotalAttempts: 2 } },
  )

  assert.deepEqual(raised(report), ['limit-total-attempts-exceeded', 'no-events-replayed'])
  assert.equal(report.summary.attempts, 2)
  assert.equal(report.status, 'incomplete')
})

test('the maxVirtualMs limit stops the replay before the backoff that would pass it', async () => {
  const report = await replayPlan(
    plan({
      receiver: { script: [{ event: 'evt_1', statuses: [503] }] },
      delivery: { maxAttempts: 3, backoffMs: 250, backoffFactor: 2, maxBackoffMs: 60000 },
    }),
    { limits: { maxVirtualMs: 100 } },
  )

  assert.deepEqual(raised(report), ['limit-virtual-time-exceeded', 'no-events-replayed'])
  assert.equal(report.summary.virtualElapsedMs, 0, 'the clock never passed the budget')
  assert.equal(report.status, 'incomplete')
})

test('the payload byte and depth limits refuse an event rather than truncating its body', async () => {
  const big = await replayPlan(
    plan({ events: [{ id: 'evt_ok', payload: {} }, { id: 'evt_big', payload: { blob: 'x'.repeat(400) } }] }),
    { limits: { maxPayloadBytes: 64 } },
  )
  assert.deepEqual(raised(big), ['limit-payload-bytes-exceeded'])
  assert.equal(big.status, 'incomplete')
  assert.equal(big.summary.skipped, 1)

  let nested = 'leaf'
  for (let index = 0; index < 12; index += 1) nested = { next: nested }
  const deep = await replayPlan(
    plan({ events: [{ id: 'evt_ok', payload: {} }, { id: 'evt_deep', payload: nested }] }),
    { limits: { maxPayloadDepth: 4 } },
  )
  assert.deepEqual(raised(deep), ['limit-payload-depth-exceeded'])
  assert.equal(deep.status, 'incomplete')
})

test('the maxFindings limit is reported, and the report says it is partial', async () => {
  const events = [1, 2, 3, 4, 5].map((index) => ({ id: `evt_${index}`, target: 'https://hooks.example.com/inbound', payload: {} }))
  const report = await replayPlan(plan({ events }), { limits: { maxFindings: 3 } })

  assert.equal(report.findings.length, 3)
  assert.equal(report.findings.some((finding) => finding.ruleId === 'limit-findings-exceeded'), true)
  assert.equal(report.status, 'incomplete')
})

/**
 * A pass with nothing behind it is the defect this guard exists for. The test
 * is `checked`, the field the guarantee is written in terms of.
 */
test('a run that reached a verdict on no event is incomplete, never a pass', async () => {
  const empty = await replayPlan(plan({ events: [] }))

  assert.deepEqual(raised(empty), ['no-events-replayed'])
  assert.equal(empty.summary.checked, 0)
  assert.equal(empty.status, 'incomplete')
  assert.notEqual(empty.status, 'pass')
})

test('a caller can inject its own clock and watch every advance', async () => {
  const advances = []
  const inner = createVirtualClock(5000)
  const spy = {
    startMs: inner.startMs,
    now: () => inner.now(),
    advance: (ms) => {
      advances.push(ms)
      return inner.advance(ms)
    },
    elapsedMs: () => inner.elapsedMs(),
  }

  const report = await replayPlan(
    plan({
      receiver: { script: [{ event: 'evt_1', statuses: [503, 200], latencyMs: 5 }] },
      delivery: { maxAttempts: 2, backoffMs: 300, backoffFactor: 1, maxBackoffMs: 1000 },
    }),
    { clock: spy },
  )

  assert.deepEqual(advances, [5, 300, 5], 'latency, backoff, latency -- and no other source of time')
  assert.deepEqual(report.replay.clock, { startMs: 5000, endMs: 5310 })
  assert.deepEqual(report.replay.receiverLog.map((entry) => entry.atMs), [5000, 5305])
})

test('startMs moves the whole timeline, and the plan can set it too', async () => {
  const fromOption = await replayPlan(plan(), { startMs: 1000 })
  assert.deepEqual(fromOption.replay.clock, { startMs: 1000, endMs: 1000 })
  assert.equal(fromOption.replay.receiverLog[0].atMs, 1000)

  const fromPlan = await replayPlan(plan({ clock: { startMs: 250 } }))
  assert.equal(fromPlan.replay.clock.startMs, 250)

  const overridden = await replayPlan(plan({ clock: { startMs: 250 } }), { startMs: 7000 })
  assert.equal(overridden.replay.clock.startMs, 7000, 'the caller wins over the plan')
})

/**
 * Virtual time is not a label on a real wait. This replay spends an hour and a
 * half of virtual time; if any of it were a real timer the suite would sit here
 * for that long instead of finishing in milliseconds.
 */
test('a replay that spends hours of virtual time takes milliseconds of real time', async () => {
  const startedAt = process.hrtime.bigint()
  const report = await replayPlan(
    plan({
      receiver: { script: [{ event: 'evt_1', statuses: [503] }] },
      delivery: { maxAttempts: 10, backoffMs: 600000, backoffFactor: 1, maxBackoffMs: 600000 },
    }),
    { limits: { maxAttemptsPerEvent: 10, maxVirtualMs: 6000000 } },
  )
  const realElapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6

  assert.equal(report.summary.virtualElapsedMs, 5400000, 'ninety minutes of virtual backoff')
  assert.equal(realElapsedMs < 2000, true, `the replay took ${realElapsedMs}ms of real time`)
  assert.deepEqual(raised(report), ['delivery-exhausted-retries'])
})

test('an event with no target at all is delivered to the declared receiver', async () => {
  const report = await replayPlan(plan({ events: [{ id: 'evt_1' }] }))

  assert.deepEqual(report.findings, [])
  assert.equal(report.replay.deliveries[0].outcome, 'delivered')
  assert.equal(report.replay.deliveries[0].source, 'inline')
})

test('the same plan replayed twice produces byte-identical output', async () => {
  const body = plan({
    receiver: { script: [{ event: 'evt_1', statuses: [503, 200], latencyMs: 3 }] },
    events: [{ id: 'evt_1', payload: { a: 1 } }, { id: 'evt_2', target: 'https://hooks.example.com/x', payload: {} }],
  })

  assert.equal(JSON.stringify(await replayPlan(body)), JSON.stringify(await replayPlan(body)))
})
