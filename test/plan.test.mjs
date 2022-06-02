import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_LIMITS, HARD_LIMITS, applyLimits, classifyUrl, isLoopbackHost, normalizeHost, replayPlan } from '../src/index.mjs'

const RECEIVER_URL = 'http://127.0.0.1:8787/hooks/orders'

function plan(overrides = {}) {
  return {
    receiver: { id: 'orders', url: RECEIVER_URL },
    events: [{ id: 'evt_1', payload: { ok: true } }],
    ...overrides,
  }
}

/** Every rule id the report raised, deduplicated and in code-unit order. */
function raised(report) {
  return [...new Set(report.findings.map((finding) => finding.ruleId))].sort()
}

test('a valid minimal plan replays and passes', async () => {
  const report = await replayPlan(plan())

  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 1)
  assert.equal(report.summary.delivered, 1)
})

test('an unknown top-level key is refused, not ignored', async () => {
  const report = await replayPlan(plan({ recevier: {} }))

  assert.deepEqual(raised(report), ['no-events-replayed', 'plan-unknown-key'])
  assert.equal(report.status, 'incomplete', 'a typo must never be the reason a run came back green')
  assert.equal(report.findings.find((finding) => finding.ruleId === 'plan-unknown-key').location.pointer, '/recevier')
})

test('an unknown key inside the receiver, an event or the delivery policy is refused too', async () => {
  for (const [subject, body, pointer] of [
    ['receiver', plan({ receiver: { id: 'orders', url: RECEIVER_URL, dedup: true } }), '/receiver/dedup'],
    ['event', plan({ events: [{ id: 'evt_1', paylod: {} }] }), '/events/0/paylod'],
    ['delivery', plan({ delivery: { maxAttemps: 2 } }), '/delivery/maxAttemps'],
    ['clock', plan({ clock: { start: 5 } }), '/clock/start'],
  ]) {
    const report = await replayPlan(body)
    const finding = report.findings.find((item) => item.ruleId === 'plan-unknown-key')

    assert.notEqual(finding, undefined, `an unknown ${subject} key must be reported`)
    assert.equal(finding.location.pointer, pointer)
    assert.equal(report.status, 'incomplete')
  }
})

test('an unknown limit name is a refusal, and a known one above its hard cap is invalid', async () => {
  const unknown = await replayPlan(plan({ limits: { maxEvent: 5 } }))
  assert.equal(unknown.findings.some((finding) => finding.ruleId === 'plan-unknown-key'), true)
  assert.equal(unknown.status, 'incomplete')

  const tooHigh = await replayPlan(plan({ limits: { maxEvents: HARD_LIMITS.maxEvents + 1 } }))
  assert.equal(tooHigh.findings.some((finding) => finding.ruleId === 'plan-invalid'), true)
  assert.equal(tooHigh.status, 'incomplete')

  const fractional = await replayPlan(plan({ limits: { maxEvents: 1.5 } }))
  assert.equal(fractional.status, 'incomplete')
})

test('limits layer defaults, then the plan, then the caller', () => {
  assert.deepEqual(applyLimits(DEFAULT_LIMITS, undefined).limits, DEFAULT_LIMITS)

  const fromPlan = applyLimits(DEFAULT_LIMITS, { maxEvents: 10 })
  assert.equal(fromPlan.limits.maxEvents, 10)
  assert.deepEqual(fromPlan.errors, [])

  const fromCaller = applyLimits(fromPlan.limits, { maxEvents: 3 })
  assert.equal(fromCaller.limits.maxEvents, 3, 'the caller wins over the plan')
  assert.equal(fromCaller.limits.maxFindings, DEFAULT_LIMITS.maxFindings, 'and leaves the rest alone')

  assert.equal(applyLimits(DEFAULT_LIMITS, { nope: 1 }).errors.length, 1)
  assert.equal(applyLimits(DEFAULT_LIMITS, { maxEvents: 0 }).errors.length, 1)
  assert.equal(applyLimits(DEFAULT_LIMITS, 'not an object').errors.length, 1)
})

test('a missing or malformed receiver stops the replay', async () => {
  for (const body of [plan({ receiver: undefined }), plan({ receiver: 'http://127.0.0.1:1/x' }), plan({ receiver: { url: RECEIVER_URL } })]) {
    const report = await replayPlan(body)
    assert.equal(report.findings.some((finding) => finding.ruleId === 'plan-invalid'), true)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.checked, 0)
  }
})

test('a receiver that is not local is refused and nothing is replayed', async () => {
  const report = await replayPlan(plan({ receiver: { id: 'remote', url: 'https://hooks.example.com/inbound' } }))

  assert.deepEqual(raised(report), ['no-events-replayed', 'receiver-not-declared-local'])
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.attempts, 0)
  assert.deepEqual(report.replay.receiverLog, [])
})

/**
 * The half of an allowlist that is usually missing. Listing a host does not
 * make it deliverable, because the loopback test runs first and there is no
 * way to spell past it.
 */
test('allowedHosts can only narrow the policy, never widen it', async () => {
  const widened = await replayPlan(plan({
    receiver: { id: 'remote', url: 'https://hooks.example.com/inbound' },
    allowedHosts: ['hooks.example.com'],
  }))
  assert.equal(widened.findings.some((finding) => finding.ruleId === 'receiver-not-declared-local'), true)
  assert.equal(widened.status, 'incomplete')

  const narrowed = await replayPlan(plan({
    receiver: { id: 'orders', url: 'http://localhost:8787/hooks/orders' },
    allowedHosts: ['127.0.0.1'],
  }))
  assert.equal(narrowed.findings.some((finding) => finding.ruleId === 'receiver-not-declared-local'), true, 'localhost is loopback but was not declared')
})

test('a transport other than in-process is refused, deliberately', async () => {
  const report = await replayPlan(plan({ receiver: { id: 'orders', url: RECEIVER_URL, transport: 'loopback' } }))
  const finding = report.findings.find((item) => item.ruleId === 'plan-invalid')

  assert.equal(finding.location.pointer, '/receiver/transport')
  assert.equal(finding.message.includes('in-process'), true)
  assert.equal(report.status, 'incomplete')
})

test('a script rule naming an event the plan does not declare is refused', async () => {
  const report = await replayPlan(plan({
    receiver: { id: 'orders', url: RECEIVER_URL, script: [{ event: 'evt_typo', statuses: [503, 200] }] },
  }))

  assert.equal(report.findings.some((finding) => finding.location.pointer === '/receiver/script'), true)
  assert.equal(report.status, 'incomplete', 'a scripted retry nobody wired up would otherwise look like a plain success')
})

test('an event declares one body, and a file needs a root to live in', async () => {
  const both = await replayPlan(plan({ events: [{ id: 'evt_1', payload: {}, file: 'a.json' }] }))
  assert.equal(both.findings.some((finding) => finding.ruleId === 'plan-invalid'), true)

  const rootless = await replayPlan(plan({ events: [{ id: 'evt_1', file: 'a.json' }] }))
  assert.equal(rootless.findings.some((finding) => finding.location.pointer === '/events/0/file'), true)

  const absolute = await replayPlan(plan({ eventsRoot: '/etc', events: [{ id: 'evt_1', payload: {} }] }))
  assert.equal(absolute.findings.some((finding) => finding.location.pointer === '/eventsRoot'), true)
})

test('delivery.maxAttempts is bounded by the maxAttemptsPerEvent limit', async () => {
  const report = await replayPlan(plan({ delivery: { maxAttempts: 4 } }), { limits: { maxAttemptsPerEvent: 3 } })

  const finding = report.findings.find((item) => item.location.pointer === '/delivery/maxAttempts')
  assert.notEqual(finding, undefined)
  assert.equal(report.status, 'incomplete')
})

test('ordering, allowedHosts and statuses are validated rather than coerced', async () => {
  for (const [body, pointer] of [
    [plan({ ordering: 'alphabetical' }), '/ordering'],
    [plan({ allowedHosts: [] }), '/allowedHosts'],
    [plan({ allowedHosts: ['127.0.0.1', 7] }), '/allowedHosts'],
    [plan({ receiver: { id: 'orders', url: RECEIVER_URL, script: [{ event: 'evt_1', statuses: [] }] } }), '/receiver/script/0/statuses'],
    [plan({ receiver: { id: 'orders', url: RECEIVER_URL, script: [{ event: 'evt_1', statuses: [999] }] } }), '/receiver/script/0/statuses'],
    [plan({ receiver: { id: 'orders', url: RECEIVER_URL, defaultStatus: 42 } }), '/receiver/defaultStatus'],
    [plan({ events: 'nope' }), '/events'],
    [plan({ events: [{ payload: {} }] }), '/events/0/id'],
  ]) {
    const report = await replayPlan(body)
    assert.equal(report.findings.some((finding) => finding.location.pointer === pointer), true, `${pointer} must be reported`)
    assert.equal(report.status, 'incomplete')
  }
})

test('loopback is decided on the literal host text, never by resolving it', () => {
  for (const host of ['127.0.0.1', '127.0.0.2', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]']) {
    assert.equal(isLoopbackHost(host), true, `${host} names this machine`)
  }
  for (const host of ['10.0.0.1', '128.0.0.1', '127.0.0.256', 'example.com', 'localhost.evil.test', '0.0.0.0']) {
    assert.equal(isLoopbackHost(host), false, `${host} does not`)
  }
  assert.equal(normalizeHost('[::1]'), '::1')
})

test('a URL is classified on its origin, path and query, with the fragment dropped', () => {
  const allowed = ['127.0.0.1']
  assert.equal(classifyUrl('http://127.0.0.1:8787/hooks?x=1#frag', allowed).key, 'http://127.0.0.1:8787/hooks?x=1')
  assert.equal(classifyUrl('http://127.0.0.1:8787/hooks', allowed).key, classifyUrl('http://127.0.0.1:8787/hooks#other', allowed).key)

  assert.equal(classifyUrl('https://hooks.example.com/x', allowed).reason, 'host')
  assert.equal(classifyUrl('ftp://127.0.0.1/x', allowed).reason, 'invalid')
  assert.equal(classifyUrl('/relative/path', allowed).reason, 'invalid')
  assert.equal(classifyUrl('http://user:pass@127.0.0.1:8787/hooks', allowed).reason, 'invalid', 'a fixture must not carry credentials in a URL')
  assert.equal(classifyUrl('', allowed).reason, 'invalid')
})

test('the API refuses an unknown option or an impossible clock request', async () => {
  await assert.rejects(() => replayPlan(plan(), { roots: '.' }), TypeError)
  await assert.rejects(() => replayPlan(plan(), { startMs: -1 }), TypeError)
  await assert.rejects(() => replayPlan(plan(), { label: '' }), TypeError)
  await assert.rejects(() => replayPlan(plan(), { limits: { maxEvents: 0 } }), TypeError)
  await assert.rejects(
    () => replayPlan(plan(), { clock: { startMs: 0, now: () => 0, advance: () => 0, elapsedMs: () => 0 }, startMs: 5 }),
    TypeError,
  )
})

test('a plan that is not an object at all is reported rather than thrown', async () => {
  for (const body of [null, 'plan', 42, ['events']]) {
    const report = await replayPlan(body)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.checked, 0)
    assert.equal(report.replay.receiver, null)
  }
})
