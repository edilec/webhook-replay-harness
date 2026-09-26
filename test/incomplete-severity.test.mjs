import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/**
 * The error rules that also make the run `incomplete`.
 *
 * Their exit code is 2 whichever way their severity is written, so the exit
 * code alone cannot pin them. What is pinned here instead is what the run
 * *says*: the status, the number of errors counted into the summary, and the
 * severity word printed at the head of the human line.
 *
 * This file deliberately imports nothing from `src/`. There is no rule table,
 * no severity map and no shared list of expectations in it: every value below
 * is a literal written out at its own case. A coordinated edit of the table,
 * the documentation and a test map cannot reach these assertions, because
 * there is nothing here for such an edit to touch.
 */

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/webhook-replay-harness.mjs')
const NEWLINE = String.fromCharCode(10)
const RECEIVER_URL = 'http://127.0.0.1:8787/hooks/orders'

async function withBase(body) {
  const base = await mkdtemp(join(tmpdir(), 'webhook-replay-harness-incomplete-'))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

/** Run the real binary with the human summary on, and report what came back. */
async function replay(build, extraArgs = []) {
  return withBase(async (base) => {
    const planPath = await build(base)
    try {
      const { stdout, stderr } = await run(process.execPath, [CLI, '--plan', planPath, ...extraArgs], { cwd: projectDirectory, maxBuffer: 32 * 1024 * 1024 })
      return { code: 0, stdout, stderr }
    } catch (error) {
      return { code: error.code, stdout: error.stdout, stderr: error.stderr }
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

function receiver(extra = {}) {
  return { id: 'orders', url: RECEIVER_URL, ...extra }
}

/**
 * Assert one case, spelling out every expectation inline.
 *
 * `errors` is the number the summary must count, and `ruleId` must appear on a
 * human line that begins with the word ERROR. Both are literals at the call
 * site, never looked up.
 */
async function assertIncomplete({ code, stdout, stderr }, ruleId, errors) {
  const report = JSON.parse(stdout)

  assert.equal(code, 2, `${ruleId} must exit 2`)
  assert.equal(report.status, 'incomplete', `${ruleId} must make the run incomplete`)
  assert.equal(report.summary.errors, errors, `${ruleId} must count ${errors} error(s)`)
  assert.equal(report.findings.some((finding) => finding.ruleId === ruleId), true, `${ruleId} must be raised`)

  const printed = stderr.split(NEWLINE).filter((line) => line.includes(` ${ruleId} `))
  assert.equal(printed.length >= 1, true, `${ruleId} must appear in the human summary`)
  assert.equal(printed[0].startsWith('ERROR  '), true, `${ruleId} must print the severity word ERROR, not WARNING or INFO`)
  assert.equal(stderr.includes('this is not a pass'), true)
}

test('plan-unreadable: exit 2, incomplete, 2 errors, printed as ERROR', async () => {
  const result = await withBase(async (base) => {
    try {
      const { stdout, stderr } = await run(process.execPath, [CLI, '--plan', join(base, 'absent.json')], { cwd: projectDirectory })
      return { code: 0, stdout, stderr }
    } catch (error) {
      return { code: error.code, stdout: error.stdout, stderr: error.stderr }
    }
  })
  await assertIncomplete(result, 'plan-unreadable', 2)
})

test('plan-not-utf8: exit 2, incomplete, 2 errors, printed as ERROR', async () => {
  const result = await replay(async (base) => {
    const path = join(base, 'plan.json')
    await writeFile(path, Uint8Array.from([0x7b, 0xff, 0xfe, 0x7d]))
    return path
  })
  await assertIncomplete(result, 'plan-not-utf8', 2)
})

test('plan-not-json: exit 2, incomplete, 2 errors, printed as ERROR', async () => {
  const result = await replay(async (base) => {
    const path = join(base, 'plan.json')
    await writeFile(path, '{ "receiver": ')
    return path
  })
  await assertIncomplete(result, 'plan-not-json', 2)
})

test('limit-plan-bytes-exceeded: exit 2, incomplete, 2 errors, printed as ERROR', async () => {
  const result = await replay(async (base) => {
    const path = join(base, 'plan.json')
    await writeFile(path, 'x'.repeat(1048577))
    return path
  })
  await assertIncomplete(result, 'limit-plan-bytes-exceeded', 2)
})

test('plan-invalid: exit 2, incomplete, 2 errors, printed as ERROR', async () => {
  const result = await replay(writePlan({ events: [{ id: 'evt_1', payload: {} }] }))
  await assertIncomplete(result, 'plan-invalid', 2)
})

test('plan-unknown-key: exit 2, incomplete, 2 errors, printed as ERROR', async () => {
  const result = await replay(writePlan({ receiver: receiver(), events: [{ id: 'evt_1', payload: {} }], oredring: 'fixture' }))
  await assertIncomplete(result, 'plan-unknown-key', 2)
})

test('receiver-not-declared-local: exit 2, incomplete, 2 errors, printed as ERROR', async () => {
  const result = await replay(writePlan({
    receiver: { id: 'remote', url: 'https://hooks.example.com/inbound' },
    events: [{ id: 'evt_1', payload: {} }],
  }))
  await assertIncomplete(result, 'receiver-not-declared-local', 2)
})

test('no-events-replayed: exit 2, incomplete, 1 error, printed as ERROR', async () => {
  const result = await replay(writePlan({ receiver: receiver(), events: [] }))
  await assertIncomplete(result, 'no-events-replayed', 1)
})

test('limit-events-exceeded: exit 2, incomplete, 1 error, printed as ERROR', async () => {
  const result = await replay(
    writePlan({
      receiver: receiver(),
      events: [{ id: 'evt_1', payload: {} }, { id: 'evt_2', payload: {} }, { id: 'evt_3', payload: {} }],
    }),
    ['--max-events', '2'],
  )
  await assertIncomplete(result, 'limit-events-exceeded', 1)
})

test('limit-total-attempts-exceeded: exit 2, incomplete, 2 errors, printed as ERROR', async () => {
  const result = await replay(
    writePlan({
      receiver: receiver({ script: [{ event: 'evt_1', statuses: [500] }, { event: 'evt_2', statuses: [500] }] }),
      delivery: { maxAttempts: 3, backoffMs: 10, backoffFactor: 1, maxBackoffMs: 100 },
      events: [{ id: 'evt_1', payload: {} }, { id: 'evt_2', payload: {} }],
    }),
    ['--max-total-attempts', '2'],
  )
  await assertIncomplete(result, 'limit-total-attempts-exceeded', 2)
})

test('limit-virtual-time-exceeded: exit 2, incomplete, 2 errors, printed as ERROR', async () => {
  const result = await replay(
    writePlan({
      receiver: receiver({ script: [{ event: 'evt_1', statuses: [503] }] }),
      delivery: { maxAttempts: 3, backoffMs: 250, backoffFactor: 2, maxBackoffMs: 60000 },
      events: [{ id: 'evt_1', payload: {} }],
    }),
    ['--max-virtual-ms', '100'],
  )
  await assertIncomplete(result, 'limit-virtual-time-exceeded', 2)
})

test('limit-payload-bytes-exceeded: exit 2, incomplete, 1 error, printed as ERROR', async () => {
  const result = await replay(
    writePlan({
      receiver: receiver(),
      events: [{ id: 'evt_ok', payload: {} }, { id: 'evt_big', payload: { blob: 'x'.repeat(400) } }],
    }),
    ['--max-payload-bytes', '64'],
  )
  await assertIncomplete(result, 'limit-payload-bytes-exceeded', 1)
})

test('limit-payload-depth-exceeded: exit 2, incomplete, 1 error, printed as ERROR', async () => {
  let nested = 'leaf'
  for (let index = 0; index < 12; index += 1) nested = { next: nested }
  const result = await replay(
    writePlan({
      receiver: receiver(),
      events: [{ id: 'evt_ok', payload: {} }, { id: 'evt_deep', payload: nested }],
    }),
    ['--max-payload-depth', '4'],
  )
  await assertIncomplete(result, 'limit-payload-depth-exceeded', 1)
})

test('limit-findings-exceeded: exit 2, incomplete, 3 errors, printed as ERROR', async () => {
  const events = [1, 2, 3, 4, 5].map((index) => ({ id: `evt_${index}`, target: 'https://hooks.example.com/inbound', payload: {} }))
  const result = await replay(writePlan({ receiver: receiver(), events }), ['--max-findings', '3'])
  await assertIncomplete(result, 'limit-findings-exceeded', 3)
})

test('event-file-unreadable: exit 2, incomplete, 1 error, printed as ERROR', async () => {
  const result = await replay(async (base) => {
    await mkdir(join(base, 'events'))
    return writePlan({
      receiver: receiver(),
      eventsRoot: 'events',
      events: [{ id: 'evt_ok', payload: {} }, { id: 'evt_missing', file: 'absent.json' }],
    })(base)
  })
  await assertIncomplete(result, 'event-file-unreadable', 1)
})

test('event-file-not-utf8: exit 2, incomplete, 1 error, printed as ERROR', async () => {
  const result = await replay(async (base) => {
    await mkdir(join(base, 'events'))
    await writeFile(join(base, 'events', 'bad.json'), Uint8Array.from([0x7b, 0xff, 0xfe, 0x7d]))
    return writePlan({
      receiver: receiver(),
      eventsRoot: 'events',
      events: [{ id: 'evt_ok', payload: {} }, { id: 'evt_bad', file: 'bad.json' }],
    })(base)
  })
  await assertIncomplete(result, 'event-file-not-utf8', 1)
})

test('event-file-not-json: exit 2, incomplete, 1 error, printed as ERROR', async () => {
  const result = await replay(async (base) => {
    await mkdir(join(base, 'events'))
    await writeFile(join(base, 'events', 'bad.json'), '{ nope')
    return writePlan({
      receiver: receiver(),
      eventsRoot: 'events',
      events: [{ id: 'evt_ok', payload: {} }, { id: 'evt_bad', file: 'bad.json' }],
    })(base)
  })
  await assertIncomplete(result, 'event-file-not-json', 1)
})
