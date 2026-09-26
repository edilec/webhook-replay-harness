import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/**
 * Severity, pinned by consequence alone.
 *
 * This file imports nothing from `src/`. It holds no rule table, no severity
 * map, no list of cases and no parameterised expectation: every value below is
 * a literal written out at the assertion that uses it. A coordinated edit of
 * the frozen table, the documented catalog and a table of expected values in
 * another test file reaches none of it, because there is nothing here for such
 * an edit to touch -- and an exit code cannot be edited at all.
 *
 * The rules below are the ones where severity is the whole of the verdict.
 * Every other error rule also marks the run incomplete, so it exits 2 whichever
 * way its severity is written; `test/incomplete-severity.test.mjs` pins those
 * the same way, on the counted errors and the printed severity word.
 */

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/webhook-replay-harness.mjs')
const NEWLINE = String.fromCharCode(10)

async function withBase(body) {
  const base = await mkdtemp(join(tmpdir(), 'webhook-replay-harness-decides-'))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

/** Write the plan, run the real binary over it, and hand back what it did. */
async function replay(build) {
  return withBase(async (base) => {
    const planPath = await build(base)
    try {
      const { stdout, stderr } = await run(process.execPath, [CLI, '--plan', planPath], { cwd: projectDirectory })
      return { code: 0, report: JSON.parse(stdout), stderr }
    } catch (error) {
      return { code: error.code, report: JSON.parse(error.stdout), stderr: error.stderr }
    }
  })
}

function writePlan(body) {
  return async (base) => {
    const path = join(base, 'plan.json')
    await writeFile(path, JSON.stringify(body, null, 2))
    return path
  }
}

test('target-host-not-allowed fails the run: exit 1, status fail, 1 error, printed ERROR', async () => {
  const { code, report, stderr } = await replay(writePlan({
    receiver: { id: 'orders', url: 'http://127.0.0.1:8787/hooks/orders' },
    events: [{ id: 'evt_1', target: 'https://hooks.example.com/inbound', payload: {} }],
  }))
  const printed = stderr.split(NEWLINE).filter((line) => line.includes(' target-host-not-allowed '))

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(report.summary.refused, 1)
  assert.equal(printed.length, 1)
  assert.equal(printed[0].startsWith('ERROR  '), true)
  assert.equal(printed[0].startsWith('WARNING'), false)
})

test('target-not-declared-receiver fails the run: exit 1, status fail, 1 error, printed ERROR', async () => {
  const { code, report, stderr } = await replay(writePlan({
    receiver: { id: 'orders', url: 'http://127.0.0.1:8787/hooks/orders' },
    events: [{ id: 'evt_1', target: 'http://127.0.0.1:9999/hooks/orders', payload: {} }],
  }))
  const printed = stderr.split(NEWLINE).filter((line) => line.includes(' target-not-declared-receiver '))

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(report.summary.refused, 1)
  assert.equal(printed.length, 1)
  assert.equal(printed[0].startsWith('ERROR  '), true)
  assert.equal(printed[0].startsWith('WARNING'), false)
})

test('target-url-invalid fails the run: exit 1, status fail, 1 error, printed ERROR', async () => {
  const { code, report, stderr } = await replay(writePlan({
    receiver: { id: 'orders', url: 'http://127.0.0.1:8787/hooks/orders' },
    events: [{ id: 'evt_1', target: 'ftp://127.0.0.1/hooks/orders', payload: {} }],
  }))
  const printed = stderr.split(NEWLINE).filter((line) => line.includes(' target-url-invalid '))

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(report.summary.refused, 1)
  assert.equal(printed.length, 1)
  assert.equal(printed[0].startsWith('ERROR  '), true)
  assert.equal(printed[0].startsWith('WARNING'), false)
})

test('event-header-credential fails the run: exit 1, status fail, 1 error, printed ERROR', async () => {
  const { code, report, stderr } = await replay(writePlan({
    receiver: { id: 'orders', url: 'http://127.0.0.1:8787/hooks/orders' },
    events: [{ id: 'evt_1', headers: { Authorization: 'Bearer REDACTED' }, payload: {} }],
  }))
  const printed = stderr.split(NEWLINE).filter((line) => line.includes(' event-header-credential '))

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(report.summary.refused, 1)
  assert.equal(printed.length, 1)
  assert.equal(printed[0].startsWith('ERROR  '), true)
  assert.equal(printed[0].startsWith('WARNING'), false)
})

test('event-file-outside-root fails the run: exit 1, status fail, 1 error, printed ERROR', async () => {
  const { code, report, stderr } = await replay(async (base) => {
    await mkdir(join(base, 'events'))
    await mkdir(join(base, 'outside'))
    await writeFile(join(base, 'outside', 'secret.json'), JSON.stringify({ marker: 'OUTSIDE_CONTENT_MARKER' }))
    await symlink(join(base, 'outside', 'secret.json'), join(base, 'events', 'escape.json'))
    return writePlan({
      receiver: { id: 'orders', url: 'http://127.0.0.1:8787/hooks/orders' },
      eventsRoot: 'events',
      events: [{ id: 'evt_1', file: 'escape.json' }],
    })(base)
  })
  const printed = stderr.split(NEWLINE).filter((line) => line.includes(' event-file-outside-root '))

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(report.summary.refused, 1)
  assert.equal(printed.length, 1)
  assert.equal(printed[0].startsWith('ERROR  '), true)
  assert.equal(printed[0].startsWith('WARNING'), false)
})

test('delivery-exhausted-retries fails the run: exit 1, status fail, 1 error, printed ERROR', async () => {
  const { code, report, stderr } = await replay(writePlan({
    receiver: { id: 'orders', url: 'http://127.0.0.1:8787/hooks/orders', script: [{ event: 'evt_1', statuses: [500] }] },
    delivery: { maxAttempts: 2, backoffMs: 50, backoffFactor: 2, maxBackoffMs: 1000 },
    events: [{ id: 'evt_1', payload: {} }],
  }))
  const printed = stderr.split(NEWLINE).filter((line) => line.includes(' delivery-exhausted-retries '))

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(report.summary.failed, 1)
  assert.equal(printed.length, 1)
  assert.equal(printed[0].startsWith('ERROR  '), true)
  assert.equal(printed[0].startsWith('WARNING'), false)
})

test('delivery-rejected-permanently fails the run: exit 1, status fail, 1 error, printed ERROR', async () => {
  const { code, report, stderr } = await replay(writePlan({
    receiver: { id: 'orders', url: 'http://127.0.0.1:8787/hooks/orders', script: [{ event: 'evt_1', statuses: [410] }] },
    delivery: { maxAttempts: 2, backoffMs: 50, backoffFactor: 2, maxBackoffMs: 1000 },
    events: [{ id: 'evt_1', payload: {} }],
  }))
  const printed = stderr.split(NEWLINE).filter((line) => line.includes(' delivery-rejected-permanently '))

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(report.summary.failed, 1)
  assert.equal(printed.length, 1)
  assert.equal(printed[0].startsWith('ERROR  '), true)
  assert.equal(printed[0].startsWith('WARNING'), false)
})

test('duplicate-event-id-redelivered fails the run: exit 1, status fail, 1 error, printed ERROR', async () => {
  const { code, report, stderr } = await replay(writePlan({
    receiver: { id: 'orders', url: 'http://127.0.0.1:8787/hooks/orders', dedupe: false },
    events: [{ id: 'evt_1', payload: {} }, { id: 'evt_1', payload: {} }],
  }))
  const printed = stderr.split(NEWLINE).filter((line) => line.includes(' duplicate-event-id-redelivered '))

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(report.summary.delivered, 2)
  assert.equal(printed.length, 1)
  assert.equal(printed[0].startsWith('ERROR  '), true)
  assert.equal(printed[0].startsWith('WARNING'), false)
})

/**
 * The other direction, which a severity table forgets more often: a retry that
 * eventually succeeded and a duplicate the receiver correctly suppressed are
 * worth reporting and must not fail the build. Promoting either to `error`
 * turns a healthy replay into a broken one.
 */

test('delivery-retried does not fail the run: exit 0, status pass, 0 errors, printed INFO', async () => {
  const { code, report, stderr } = await replay(writePlan({
    receiver: { id: 'orders', url: 'http://127.0.0.1:8787/hooks/orders', script: [{ event: 'evt_1', statuses: [503, 200] }] },
    delivery: { maxAttempts: 2, backoffMs: 50, backoffFactor: 2, maxBackoffMs: 1000 },
    events: [{ id: 'evt_1', payload: {} }],
  }))
  const printed = stderr.split(NEWLINE).filter((line) => line.includes(' delivery-retried '))

  assert.equal(code, 0)
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 1)
  assert.equal(report.summary.delivered, 1)
  assert.equal(printed.length, 1)
  assert.equal(printed[0].startsWith('INFO   '), true)
  assert.equal(printed[0].startsWith('ERROR'), false)
})

test('duplicate-event-id-deduplicated does not fail the run: exit 0, status pass, 0 errors, printed WARNING', async () => {
  const { code, report, stderr } = await replay(writePlan({
    receiver: { id: 'orders', url: 'http://127.0.0.1:8787/hooks/orders', dedupe: true },
    events: [{ id: 'evt_1', payload: {} }, { id: 'evt_1', payload: {} }],
  }))
  const printed = stderr.split(NEWLINE).filter((line) => line.includes(' duplicate-event-id-deduplicated '))

  assert.equal(code, 0)
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 1)
  assert.equal(report.summary.info, 0)
  assert.equal(report.summary.deduplicated, 1)
  assert.equal(printed.length, 1)
  assert.equal(printed[0].startsWith('WARNING'), true)
  assert.equal(printed[0].startsWith('ERROR'), false)
})
