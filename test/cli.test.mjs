import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/webhook-replay-harness.mjs')
const NEWLINE = String.fromCharCode(10)
const RECEIVER_URL = 'http://127.0.0.1:8787/hooks/orders'

async function cli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd: projectDirectory, maxBuffer: 32 * 1024 * 1024 })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

async function withPlan(body, run_) {
  const base = await mkdtemp(join(tmpdir(), 'webhook-replay-harness-cli-'))
  try {
    const planPath = join(base, 'plan.json')
    await writeFile(planPath, typeof body === 'string' ? body : JSON.stringify(body, null, 2))
    return await run_(planPath, base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

function cleanPlan(overrides = {}) {
  return {
    receiver: { id: 'orders', url: RECEIVER_URL },
    events: [{ id: 'evt_1', payload: { ok: true } }],
    ...overrides,
  }
}

test('--help explains the tool and exits 0 with nothing on stderr', async () => {
  const { code, stdout, stderr } = await cli(['--help'])

  assert.equal(code, 0)
  assert.equal(stderr, '')
  assert.equal(stdout.includes('Usage:'), true)
  assert.equal(stdout.includes('--plan FILE'), true)
  assert.equal(stdout.includes('Exit codes:'), true)
  assert.equal(stdout.includes('refused'), true, 'the safety property belongs in the help text')
})

test('--version prints the version and nothing else', async () => {
  const { code, stdout } = await cli(['--version'])

  assert.equal(code, 0)
  assert.equal(stdout, `0.1.0${NEWLINE}`)
})

test('an unknown option is a configuration error with an empty stdout', async () => {
  const { code, stdout, stderr } = await cli(['--plan', 'examples/clean/plan.json', '--jsn'])

  assert.equal(code, 2)
  assert.equal(stdout, '', 'a run that never had a subject has nothing to report about')
  assert.equal(stderr.includes('Unknown option "--jsn"'), true)
})

test('a missing --plan and a repeated value-carrying flag are both configuration errors', async () => {
  const missing = await cli(['--json'])
  assert.equal(missing.code, 2)
  assert.equal(missing.stdout, '')
  assert.equal(missing.stderr.includes('--plan is required'), true)

  const repeated = await cli(['--plan', 'a.json', '--plan', 'b.json'])
  assert.equal(repeated.code, 2)
  assert.equal(repeated.stdout, '')
  assert.equal(repeated.stderr.includes('given more than once'), true, 'a silent last-wins is the same defect as an ignored typo')

  const valueless = await cli(['--plan'])
  assert.equal(valueless.code, 2)
  assert.equal(valueless.stdout, '')

  const notANumber = await cli(['--plan', 'examples/clean/plan.json', '--max-events', 'lots'])
  assert.equal(notANumber.code, 2)
  assert.equal(notANumber.stdout, '')
})

test('an input that could not be read produces an incomplete report on stdout', async () => {
  const { code, stdout } = await cli(['--plan', 'no/such/plan.json', '--json'])
  const report = JSON.parse(stdout)

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete', 'the run had a subject and failed to get evidence about it')
  assert.equal(report.tool, 'webhook-replay-harness')
  assert.equal(report.schemaVersion, '1')
  assert.equal(report.findings[0].ruleId, 'plan-unreadable')
  assert.equal(report.findings[0].location.file, 'no/such/plan.json')
})

test('stdout carries the JSON report and nothing else, and stderr carries the summary', async () => {
  const { code, stdout, stderr } = await cli(['--plan', 'examples/clean/plan.json'])

  assert.equal(code, 0)
  assert.equal(stdout.trimStart().startsWith('{'), true)
  assert.doesNotThrow(() => JSON.parse(stdout), 'stdout must pipe straight into a parser')
  assert.equal(stderr.includes('event(s) replayed to a verdict'), true)
  assert.equal(stderr.includes('No socket was opened'), true)
})

test('--json keeps stdout identical and silences the human summary', async () => {
  const plain = await cli(['--plan', 'examples/clean/plan.json'])
  const quiet = await cli(['--plan', 'examples/clean/plan.json', '--json'])

  assert.equal(quiet.stdout, plain.stdout, 'the report does not change shape with the flag')
  assert.equal(quiet.stderr, '')
})

test('the shipped examples exit 0 and 1 as documented', async () => {
  const clean = await cli(['--plan', 'examples/clean/plan.json', '--json'])
  assert.equal(clean.code, 0)
  assert.equal(JSON.parse(clean.stdout).status, 'pass')

  const broken = await cli(['--plan', 'examples/broken/plan.json', '--json'])
  assert.equal(broken.code, 1)
  const report = JSON.parse(broken.stdout)
  assert.equal(report.status, 'fail')
  assert.deepEqual([...new Set(report.findings.map((finding) => finding.ruleId))].sort(), [
    'delivery-exhausted-retries',
    'delivery-rejected-permanently',
    'duplicate-event-id-redelivered',
    'event-header-credential',
    'target-host-not-allowed',
    'target-not-declared-receiver',
    'target-url-invalid',
  ])
})

test('equivalent target URL spellings remain a clean one-event replay', async () => {
  await withPlan(cleanPlan({
    events: [{ id: 'evt_1', target: `${RECEIVER_URL}#fixture-only`, payload: {} }],
  }), async (planPath) => {
    const result = await cli(['--plan', planPath, '--json'])
    const report = JSON.parse(result.stdout)
    assert.equal(result.code, 0)
    assert.equal(report.status, 'pass')
    assert.equal(report.summary.checked, 1)
    assert.deepEqual(report.findings, [])
  })
})

test('a hidden character in either URL side is refused with visible differing key units', async () => {
  const hidden = `http://127.0.0.1:8787/hooks/${String.fromCharCode(0x200e)}orders`
  for (const [receiverUrl, targetUrl, targetUnit, receiverUnit] of [
    [RECEIVER_URL, hidden, 'U+0025', 'U+006F'],
    [hidden, RECEIVER_URL, 'U+006F', 'U+0025'],
  ]) {
    await withPlan(cleanPlan({
      receiver: { id: 'orders', url: receiverUrl },
      events: [{ id: 'evt_1', target: targetUrl, payload: {} }],
    }), async (planPath) => {
      const result = await cli(['--plan', planPath, '--json'])
      const report = JSON.parse(result.stdout)
      const finding = report.findings.find((item) => item.ruleId === 'target-not-declared-receiver')
      assert.equal(result.code, 1)
      assert.equal(report.status, 'fail')
      assert.equal(report.summary.checked, 1)
      assert.ok(finding)
      assert.match(finding.evidence, /URL keys first differ at UTF-16 offset \d+/)
      assert.equal(finding.evidence.includes(`target ${targetUnit}; receiver ${receiverUnit}`), true)
      assert.equal(finding.evidence.includes('orders is not orders'), false)
      assert.equal(result.stdout.includes(String.fromCharCode(0x200e)), false)
    })
  }
})

test('a URL difference beyond both evidence excerpt lengths remains explicit', async () => {
  const prefix = 'http://127.0.0.1:8787/hooks/' + 'a'.repeat(180)
  await withPlan(cleanPlan({
    receiver: { id: 'orders', url: `${prefix}y` },
    events: [{ id: 'evt_1', target: `${prefix}z`, payload: {} }],
  }), async (planPath) => {
    const result = await cli(['--plan', planPath, '--json'])
    const report = JSON.parse(result.stdout)
    const finding = report.findings.find((item) => item.ruleId === 'target-not-declared-receiver')
    assert.equal(result.code, 1)
    assert.equal(report.status, 'fail')
    assert.equal(report.summary.checked, 1)
    assert.ok(finding)
    assert.match(finding.evidence, /URL keys first differ at UTF-16 offset \d+: target U\+007A; receiver U\+0079/)
  })
})

test('two runs over the same plan write byte-identical stdout', async () => {
  const first = await cli(['--plan', 'examples/broken/plan.json', '--json'])
  const second = await cli(['--plan', 'examples/broken/plan.json', '--json'])

  assert.equal(first.stdout, second.stdout)
  assert.equal(first.stdout.length > 1000, true, 'the comparison is over a report with something in it')
})

test('--label replaces the path recorded in the report', async () => {
  const { stdout } = await cli(['--plan', 'examples/broken/plan.json', '--label', 'fixtures/orders.json', '--json'])
  const report = JSON.parse(stdout)

  assert.equal(report.findings.every((finding) => finding.location.file === 'fixtures/orders.json'), true)
  assert.equal(JSON.stringify(report).includes(projectDirectory), false, 'and no absolute host path reaches the report')
})

/**
 * The defect this pins: a documented option the CLI accepts and never wires
 * through. `--start-ms` has to move the clock the engine actually uses, not
 * merely be parsed and dropped.
 */
test('--start-ms is wired all the way through to the clock the replay uses', async () => {
  await withPlan(cleanPlan(), async (planPath) => {
    const { stdout } = await cli(['--plan', planPath, '--start-ms', '86400000', '--json'])
    const report = JSON.parse(stdout)

    assert.equal(report.replay.clock.startMs, 86400000)
    assert.equal(report.replay.receiverLog[0].atMs, 86400000, 'the attempt was stamped by that clock')
  })
})

test('--start-ms is bounded by the same value the plan clock is', async () => {
  await withPlan(cleanPlan(), async (planPath) => {
    const above = await cli(['--plan', planPath, '--start-ms', '8640000000001', '--json'])
    assert.equal(above.code, 2)
    assert.equal(above.stdout, '', 'a configuration error never had a subject to report about')
    assert.equal(above.stderr.includes('--start-ms must be no greater than 8640000000000'), true)

    const atEdge = await cli(['--plan', planPath, '--start-ms', '8640000000000', '--json'])
    assert.equal(atEdge.code, 0)
    assert.equal(JSON.parse(atEdge.stdout).replay.clock.startMs, 8640000000000)
  })
})

test('a limit flag is wired through and overrides the plan', async () => {
  await withPlan(
    cleanPlan({
      limits: { maxEvents: 500 },
      events: [{ id: 'evt_1', payload: {} }, { id: 'evt_2', payload: {} }],
    }),
    async (planPath) => {
      const relaxed = await cli(['--plan', planPath, '--json'])
      assert.equal(relaxed.code, 0)
      assert.equal(JSON.parse(relaxed.stdout).summary.checked, 2)

      const tightened = await cli(['--plan', planPath, '--max-events', '1', '--json'])
      const report = JSON.parse(tightened.stdout)
      assert.equal(tightened.code, 2)
      assert.equal(report.status, 'incomplete')
      assert.equal(report.summary.checked, 1)
      assert.equal(report.findings.some((finding) => finding.ruleId === 'limit-events-exceeded'), true)
    },
  )
})

test('a plan file that is not JSON is reported, not thrown', async () => {
  await withPlan('{ "receiver": ', async (planPath) => {
    const { code, stdout, stderr } = await cli(['--plan', planPath, '--json'])
    const report = JSON.parse(stdout)

    assert.equal(code, 2)
    assert.equal(report.findings[0].ruleId, 'plan-not-json')
    assert.equal(stderr.includes('event(s) replayed to a verdict'), false, '--json silences the human summary')
    assert.equal(stderr.includes('this is not a pass'), true, 'but a diagnostic saying the run is incomplete is not the summary')
  })
})

test('a directory passed to --plan is reported as an unreadable input', async () => {
  const base = await mkdtemp(join(tmpdir(), 'webhook-replay-harness-dir-'))
  try {
    const { code, stdout } = await cli(['--plan', base, '--json'])
    const report = JSON.parse(stdout)

    assert.equal(code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.findings[0].ruleId, 'plan-unreadable')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('the incomplete diagnostic on stderr says what was not examined', async () => {
  await withPlan(cleanPlan({ events: [] }), async (planPath) => {
    const { code, stderr } = await cli(['--plan', planPath])

    assert.equal(code, 2)
    assert.equal(stderr.includes('incomplete: 0 of 0 declared event(s) reached a verdict'), true)
    assert.equal(stderr.includes('this is not a pass'), true)
  })
})
