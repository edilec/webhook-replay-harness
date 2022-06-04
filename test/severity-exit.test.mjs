import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { RULE_SEVERITY, SEVERITY_DECIDES } from '../src/index.mjs'

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/webhook-replay-harness.mjs')
const RECEIVER_URL = 'http://127.0.0.1:8787/hooks/orders'

/**
 * Severity, pinned by what actually happens.
 *
 * A frozen table is the right source of truth, and a test that asserts the
 * table against a documented catalog and against a hand-written copy is three
 * declarations agreeing with each other: an edit that changes all three at once
 * passes every assertion, and a rule quietly demoted from `error` to `warning`
 * reaches exit 0 with the suite green.
 *
 * These tests assert the consequence instead. Each case builds a plan that
 * isolates one rule, runs the real binary over it, and pins the exact set of
 * rules raised, the report status and the process exit code. A demotion changes
 * the observable outcome -- `fail` becomes `pass`, exit 1 becomes exit 0 -- and
 * no coordinated edit to a table, a document and a test map can satisfy that.
 */

async function withBase(body) {
  const base = await mkdtemp(join(tmpdir(), 'webhook-replay-harness-severity-'))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

async function replay(build) {
  return withBase(async (base) => {
    const planPath = await build(base)
    try {
      const { stdout } = await run(process.execPath, [CLI, '--plan', planPath, '--json'], { cwd: projectDirectory })
      return { code: 0, report: JSON.parse(stdout) }
    } catch (error) {
      return { code: error.code, report: JSON.parse(error.stdout) }
    }
  })
}

/** Write one plan file, and return the path the CLI should be pointed at. */
function planFile(body, extras = {}) {
  return async (base) => {
    const path = join(base, 'plan.json')
    await writeFile(path, JSON.stringify({
      receiver: { id: 'orders', url: RECEIVER_URL, ...extras.receiver },
      delivery: { maxAttempts: 2, backoffMs: 50, backoffFactor: 2, maxBackoffMs: 1000 },
      ...body,
    }, null, 2))
    return path
  }
}

/**
 * The rules whose severity alone decides the verdict.
 *
 * Every other error rule also sets the `incomplete` flag, so it exits 2
 * whatever its severity says; `test/incomplete-severity.test.mjs` pins those.
 * These eight have no second line of defence: severity is the whole of it.
 */
const FAILING = [
  {
    ruleId: 'target-host-not-allowed',
    build: planFile({ events: [{ id: 'evt_1', target: 'https://hooks.example.com/inbound', payload: {} }] }),
  },
  {
    ruleId: 'target-not-declared-receiver',
    build: planFile({ events: [{ id: 'evt_1', target: 'http://127.0.0.1:9999/hooks/orders', payload: {} }] }),
  },
  {
    ruleId: 'target-url-invalid',
    build: planFile({ events: [{ id: 'evt_1', target: 'ftp://127.0.0.1/hooks/orders', payload: {} }] }),
  },
  {
    ruleId: 'event-header-credential',
    build: planFile({ events: [{ id: 'evt_1', headers: { Authorization: 'Bearer REDACTED' }, payload: {} }] }),
  },
  {
    ruleId: 'delivery-exhausted-retries',
    build: planFile(
      { events: [{ id: 'evt_1', payload: {} }] },
      { receiver: { script: [{ event: 'evt_1', statuses: [500] }] } },
    ),
  },
  {
    ruleId: 'delivery-rejected-permanently',
    build: planFile(
      { events: [{ id: 'evt_1', payload: {} }] },
      { receiver: { script: [{ event: 'evt_1', statuses: [410] }] } },
    ),
  },
  {
    ruleId: 'duplicate-event-id-redelivered',
    build: planFile(
      { events: [{ id: 'evt_1', payload: {} }, { id: 'evt_1', payload: {} }] },
      { receiver: { dedupe: false } },
    ),
  },
  {
    ruleId: 'event-file-outside-root',
    build: async (base) => {
      await mkdir(join(base, 'events'))
      await mkdir(join(base, 'outside'))
      await writeFile(join(base, 'outside', 'secret.json'), JSON.stringify({ marker: 'OUTSIDE_CONTENT_MARKER' }))
      await symlink(join(base, 'outside', 'secret.json'), join(base, 'events', 'escape.json'))
      return planFile({ eventsRoot: 'events', events: [{ id: 'evt_1', file: 'escape.json' }] })(base)
    },
  },
]

for (const item of FAILING) {
  test(`${item.ruleId} fails the run and exits 1, whatever a table says`, async () => {
    const { code, report } = await replay(item.build)
    const raised = [...new Set(report.findings.map((finding) => finding.ruleId))].sort()

    assert.deepEqual(raised, [item.ruleId], 'the fixture must isolate the rule under test')
    assert.equal(report.status, 'fail', `${item.ruleId} must fail the run`)
    assert.equal(code, 1, `${item.ruleId} must exit 1`)
    assert.equal(report.summary.errors, 1)
    assert.equal(RULE_SEVERITY[item.ruleId], 'error', 'and the table must still say so')
  })
}

/**
 * The other direction, which is the half a severity table usually forgets. A
 * retry that eventually succeeded and a duplicate the receiver correctly
 * deduplicated are worth reporting and must not fail the run; promoting either
 * to `error` turns a healthy replay into a broken build.
 */
const PASSING = [
  {
    ruleId: 'delivery-retried',
    severity: 'info',
    build: planFile(
      { events: [{ id: 'evt_1', payload: {} }] },
      { receiver: { script: [{ event: 'evt_1', statuses: [503, 200] }] } },
    ),
  },
  {
    ruleId: 'duplicate-event-id-deduplicated',
    severity: 'warning',
    build: planFile(
      { events: [{ id: 'evt_1', payload: {} }, { id: 'evt_1', payload: {} }] },
      { receiver: { dedupe: true } },
    ),
  },
]

for (const item of PASSING) {
  test(`${item.ruleId} is reported without failing the run, and exits 0`, async () => {
    const { code, report } = await replay(item.build)
    const raised = [...new Set(report.findings.map((finding) => finding.ruleId))].sort()

    assert.deepEqual(raised, [item.ruleId], 'the fixture must isolate the rule under test')
    assert.equal(report.status, 'pass', `${item.ruleId} must not fail the run`)
    assert.equal(code, 0, `${item.ruleId} must exit 0`)
    assert.equal(report.summary.errors, 0)
    assert.equal(RULE_SEVERITY[item.ruleId], item.severity, 'and the table must still say so')
  })
}

test('the clean plan these cases are cut from raises nothing at all', async () => {
  const { code, report } = await replay(planFile({ events: [{ id: 'evt_1', payload: {} }] }))

  assert.deepEqual(report.findings, [], 'otherwise every case above is measuring the wrong thing')
  assert.equal(report.status, 'pass')
  assert.equal(code, 0)
  assert.equal(report.summary.checked, 1)
  assert.equal(report.summary.delivered, 1)
})

test('every rule that decides pass or fail by severity alone is pinned above', () => {
  /**
   * The error rules that are backstopped by the `incomplete` flag, so their
   * exit code is 2 whatever their severity says. A new error rule that nobody
   * pins has to be added to one list or the other, deliberately.
   */
  const backstopped = [
    'event-file-not-json',
    'event-file-not-utf8',
    'event-file-unreadable',
    'limit-events-exceeded',
    'limit-findings-exceeded',
    'limit-payload-bytes-exceeded',
    'limit-payload-depth-exceeded',
    'limit-plan-bytes-exceeded',
    'limit-total-attempts-exceeded',
    'limit-virtual-time-exceeded',
    'no-events-replayed',
    'plan-invalid',
    'plan-not-json',
    'plan-not-utf8',
    'plan-unknown-key',
    'plan-unreadable',
    'receiver-not-declared-local',
  ]
  const errors = Object.entries(RULE_SEVERITY)
    .filter(([, severity]) => severity === 'error')
    .map(([ruleId]) => ruleId)
    .sort()

  assert.deepEqual(errors, [...FAILING.map((item) => item.ruleId), ...backstopped].sort())
  assert.deepEqual([...SEVERITY_DECIDES].sort(), FAILING.map((item) => item.ruleId).sort())
  assert.deepEqual(
    Object.entries(RULE_SEVERITY).filter(([, severity]) => severity !== 'error').map(([ruleId]) => ruleId).sort(),
    PASSING.map((item) => item.ruleId).sort(),
  )
})
