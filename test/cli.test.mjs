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
    assert.equal(report.replay.receiver.url, RECEIVER_URL)
    assert.equal(report.replay.receiver.redacted, false)
  })
})

test('distinct receiver endpoints hidden by report sanitisation keep distinct canonical provenance', async () => {
  const reports = []
  for (const [codePoint, encoded] of [[0x85, '%C2%85'], [0x9b, '%C2%9B']]) {
    const hidden = String.fromCharCode(codePoint)
    const url = `http://127.0.0.1:8787/h${hidden}ooks`
    await withPlan(cleanPlan({
      receiver: { id: 'orders', url },
      events: [{ id: 'evt_1', target: `${url}#fixture-only`, payload: {} }],
    }), async (planPath) => {
      const result = await cli(['--plan', planPath, '--json'])
      const report = JSON.parse(result.stdout)
      assert.equal(result.code, 0)
      assert.equal(report.status, 'pass')
      assert.equal(report.summary.delivered, 1)
      assert.deepEqual(report.findings, [])
      assert.equal(report.replay.receiver.url, `http://127.0.0.1:8787/h${encoded}ooks`)
      assert.equal(result.stdout.includes(hidden), false)
      reports.push(result.stdout)
    })
  }
  assert.notEqual(reports[0], reports[1])
})

test('ordinary receiver URL fragments do not change the canonical endpoint provenance', async () => {
  await withPlan(cleanPlan({
    receiver: { id: 'orders', url: `${RECEIVER_URL}#plan-note` },
    events: [{ id: 'evt_1', target: RECEIVER_URL, payload: {} }],
  }), async (planPath) => {
    const result = await cli(['--plan', planPath, '--json'])
    const report = JSON.parse(result.stdout)
    assert.equal(result.code, 0)
    assert.equal(report.status, 'pass')
    assert.equal(report.replay.receiver.url, RECEIVER_URL)
    assert.equal(report.replay.receiver.redacted, true)
    assert.deepEqual(report.findings, [])
  })
})

test('accepted short query and source fragment are evaluated but absent from JSON and human output', async () => {
  const canary = 'SYNTHETIC_SECRET_CANARY'
  for (const url of [`${RECEIVER_URL}?code=${canary}`, `${RECEIVER_URL}#${canary}`]) {
    await withPlan(cleanPlan({
      receiver: { id: 'orders', url },
      events: [{ id: 'evt_1', target: url, payload: {} }],
    }), async (planPath) => {
      const result = await cli(['--plan', planPath])
      const report = JSON.parse(result.stdout)
      assert.equal(result.code, 0)
      assert.equal(report.status, 'pass')
      assert.equal(report.summary.delivered, 1)
      assert.deepEqual(report.findings, [])
      assert.equal(report.replay.receiver.pointer, '/receiver/url')
      assert.equal(report.replay.receiver.redacted, true)
      assert.equal(report.replay.receiver.truncated, false)
      assert.equal(report.replay.receiver.url, url.includes('?') ? `${RECEIVER_URL}?[redacted-query]` : RECEIVER_URL)
      assert.equal(result.stdout.includes(canary), false)
      assert.equal(result.stderr.includes(canary), false)
    })
  }
})

test('short query mismatch and external target findings redact both evidence and suggestions', async () => {
  const canary = 'SYNTHETIC_SECRET_CANARY'
  const receiverUrl = `${RECEIVER_URL}?code=${canary}`
  for (const [target, ruleId] of [
    [`${RECEIVER_URL}?code=${canary}_ALT`, 'target-not-declared-receiver'],
    [`https://outside.example.invalid/hook?code=${canary}`, 'target-host-not-allowed'],
    [`not-a-url?code=${canary}#${canary}`, 'target-url-invalid'],
  ]) {
    await withPlan(cleanPlan({
      receiver: { id: 'orders', url: receiverUrl },
      events: [{ id: 'evt_1', target, payload: {} }],
    }), async (planPath) => {
      const result = await cli(['--plan', planPath])
      const report = JSON.parse(result.stdout)
      const finding = report.findings.find((row) => row.ruleId === ruleId)
      assert.equal(result.code, 1)
      assert.equal(report.status, 'fail')
      assert.equal(finding.location.pointer, '/events/0/target')
      if (ruleId === 'target-not-declared-receiver') {
        assert.equal(finding.evidence, 'Exact URL values differ beyond the displayed excerpt; target /events/0/target; receiver /receiver/url')
      } else {
        assert.match(finding.evidence, /\[redacted-query\]/)
        assert.match(finding.suggestion, /\[redacted-query\]/)
        if (ruleId === 'target-url-invalid') assert.match(finding.evidence, /#\[redacted-fragment\]/)
      }
      assert.equal(result.stdout.includes(canary), false)
      assert.equal(result.stderr.includes(canary), false)
    })
  }
})

test('a refused receiver URL masks query and fragment values in its incomplete finding', async () => {
  const canary = 'SYNTHETIC_SECRET_CANARY'
  await withPlan(cleanPlan({
    receiver: { id: 'orders', url: `https://outside.example.invalid/hook?code=${canary}#${canary}` },
  }), async (planPath) => {
    const result = await cli(['--plan', planPath])
    const report = JSON.parse(result.stdout)
    const finding = report.findings.find((row) => row.ruleId === 'receiver-not-declared-local')
    assert.equal(result.code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(finding.location.pointer, '/receiver/url')
    assert.match(finding.message, /\?\[redacted-query\]#\[redacted-fragment\]/)
    assert.equal(result.stdout.includes(canary), false)
    assert.equal(result.stderr.includes(canary), false)
  })
})

test('long receiver query values have bounded excerpts, source pointers and no published digest', async () => {
  const prefix = `${RECEIVER_URL}?pad=${'a'.repeat(210)}&code=`
  const urls = []
  for (const suffix of ['RED', 'BLUE']) {
    const url = `${prefix}${suffix}`
    await withPlan(cleanPlan({
      receiver: { id: 'orders', url },
      events: [{ id: 'evt_1', target: url, payload: {} }],
    }), async (planPath) => {
      const result = await cli(['--plan', planPath, '--json'])
      const report = JSON.parse(result.stdout)
      assert.equal(result.code, 0)
      assert.equal(report.status, 'pass')
      assert.equal(report.summary.delivered, 1)
      assert.deepEqual(report.findings, [])
      assert.ok(report.replay.receiver.url.length <= 203)
      assert.ok(report.replay.receiver.url.endsWith('?[redacted-query]'))
      assert.equal(report.replay.receiver.pointer, '/receiver/url')
      assert.equal(report.replay.receiver.truncated, false)
      assert.equal(report.replay.receiver.redacted, true)
      assert.equal(Object.hasOwn(report.replay.receiver, 'urlKeySha256'), false)
      assert.equal(result.stdout.includes(suffix), false)
      urls.push(report.replay.receiver.url)
    })
  }
  assert.equal(urls[0], urls[1], 'the bounded URL excerpt alone is ambiguous')
})

test('receiver URL truncation flag is false at 200 canonical units and true at 201', async () => {
  const atBound = `${RECEIVER_URL}/${'a'.repeat(200 - RECEIVER_URL.length - 1)}`
  assert.equal(atBound.length, 200)
  for (const [url, truncated] of [[atBound, false], [`${atBound}X`, true]]) {
    await withPlan(cleanPlan({
      receiver: { id: 'orders', url },
      events: [{ id: 'evt_1', target: url, payload: {} }],
    }), async (planPath) => {
      const result = await cli(['--plan', planPath, '--json'])
      const report = JSON.parse(result.stdout)
      assert.equal(result.code, 0)
      assert.equal(report.status, 'pass')
      assert.equal(report.replay.receiver.pointer, '/receiver/url')
      assert.equal(report.replay.receiver.truncated, truncated)
      assert.equal(report.replay.receiver.redacted, false)
      assert.equal(report.replay.receiver.url, truncated ? `${atBound}...` : atBound)
    })
  }
})

test('a hidden character in either URL side is refused with distinct canonical excerpts', async () => {
  const hidden = `http://127.0.0.1:8787/hooks/${String.fromCharCode(0x200e)}orders`
  for (const [receiverUrl, targetUrl] of [
    [RECEIVER_URL, hidden],
    [hidden, RECEIVER_URL],
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
      assert.match(finding.evidence, /^target http:\/\/127\.0\.0\.1:8787\/hooks\//)
      assert.match(finding.evidence, /%E2%80%8E/)
      assert.equal(finding.evidence.includes('UTF-16 offset'), false)
      assert.equal(finding.evidence.includes('orders is not orders'), false)
      assert.equal(result.stdout.includes(String.fromCharCode(0x200e)), false)
    })
  }
})

test('a hidden receiver query mismatch stays located without revealing suffix characters', async () => {
  const prefix = `${RECEIVER_URL}?pad=${'a'.repeat(210)}&code=`
  await withPlan(cleanPlan({
    receiver: { id: 'orders', url: `${prefix}RED` },
    events: [{ id: 'evt_1', target: `${prefix}BLUE`, payload: {} }],
  }), async (planPath) => {
    const result = await cli(['--plan', planPath, '--json'])
    const report = JSON.parse(result.stdout)
    const finding = report.findings.find((item) => item.ruleId === 'target-not-declared-receiver')
    assert.equal(result.code, 1)
    assert.equal(report.status, 'fail')
    assert.equal(report.summary.checked, 1)
    assert.ok(finding)
    assert.equal(finding.location.pointer, '/events/0/target')
    assert.equal(finding.evidence, 'Exact URL values differ beyond the displayed excerpt; target /events/0/target; receiver /receiver/url')
    assert.equal(report.replay.receiver.pointer, '/receiver/url')
    assert.equal(report.replay.receiver.truncated, false)
    assert.equal(report.replay.receiver.redacted, true)
    const rendered = JSON.stringify(report)
    assert.equal(rendered.includes('urlKeySha256'), false)
    assert.equal(rendered.includes('RED'), false)
    assert.equal(rendered.includes('BLUE'), false)
    assert.equal(rendered.includes('U+0052'), false)
    assert.equal(rendered.includes('U+0042'), false)
  })
})

test('ordinary and long-whitespace-prefixed visible ids remain valid', async () => {
  await withPlan(cleanPlan({
    receiver: { id: 'orders receiver', url: RECEIVER_URL },
    events: [{ id: `${' '.repeat(160)}A`, payload: {} }],
  }), async (planPath) => {
    const result = await cli(['--plan', planPath, '--json'])
    const report = JSON.parse(result.stdout)
    assert.equal(result.code, 0)
    assert.equal(report.status, 'pass')
    assert.equal(report.summary.checked, 1)
    assert.deepEqual(report.findings, [])
    assert.equal(report.replay.receiver.id, 'orders receiver')
    assert.equal(report.replay.deliveries[0].eventId, 'A')
  })
})

test('a rendered-empty event or receiver id makes the plan incomplete', async () => {
  const invisible = String.fromCharCode(0x200e)
  for (const [subject, body, pointer] of [
    ['event', cleanPlan({ events: [{ id: invisible, payload: {} }] }), '/events/0/id'],
    ['receiver', cleanPlan({ receiver: { id: invisible, url: RECEIVER_URL } }), '/receiver/id'],
  ]) {
    await withPlan(body, async (planPath) => {
      const result = await cli(['--plan', planPath, '--json'])
      const report = JSON.parse(result.stdout)
      assert.equal(result.code, 2, `${subject} id was treated as a complete plan`)
      assert.equal(report.status, 'incomplete')
      assert.equal(report.summary.checked, 0)
      const finding = report.findings.find((item) => item.ruleId === 'plan-invalid' && item.location.pointer === pointer)
      assert.ok(finding, `${subject} id needs a pointed plan-invalid finding`)
      assert.match(finding.message, /visible characters/)
      assert.equal(result.stdout.includes(invisible), false)
    })
  }
})

test('different raw event ids with the same report spelling are refused on either side', async () => {
  const marked = `foo${String.fromCharCode(0x200e)}bar`
  for (const ids of [[marked, 'foo bar'], ['foo bar', marked]]) {
    await withPlan(cleanPlan({
      events: ids.map((id) => ({ id, payload: {} })),
    }), async (planPath) => {
      const result = await cli(['--plan', planPath, '--json'])
      const report = JSON.parse(result.stdout)
      assert.equal(result.code, 2)
      assert.equal(report.status, 'incomplete')
      assert.equal(report.summary.checked, 0)
      const finding = report.findings.find((item) => item.ruleId === 'plan-invalid' && item.location.pointer === '/events/1/id')
      assert.ok(finding)
      assert.match(finding.message, /renders identically to the distinct id at \/events\/0\/id/)
      assert.equal(result.stdout.includes(String.fromCharCode(0x200e)), false)
    })
  }
})

test('an exact duplicate event id remains a legitimate deduplication case', async () => {
  await withPlan(cleanPlan({
    events: [{ id: 'foo bar', payload: {} }, { id: 'foo bar', payload: {} }],
  }), async (planPath) => {
    const result = await cli(['--plan', planPath, '--json'])
    const report = JSON.parse(result.stdout)
    assert.equal(result.code, 0)
    assert.equal(report.status, 'pass')
    assert.equal(report.summary.checked, 2)
    assert.equal(report.findings.some((item) => item.ruleId === 'plan-invalid'), false)
    assert.equal(report.findings.some((item) => item.ruleId === 'duplicate-event-id-deduplicated'), true)
  })
})

test('an exact raw script event id still selects its declared event', async () => {
  for (const id of ['foo bar', `foo${String.fromCharCode(0x200e)}bar`]) {
    await withPlan(cleanPlan({
      receiver: { id: 'orders', url: RECEIVER_URL, script: [{ event: id, statuses: [201] }] },
      events: [{ id, payload: {} }],
    }), async (planPath) => {
      const result = await cli(['--plan', planPath, '--json'])
      const report = JSON.parse(result.stdout)
      assert.equal(result.code, 0)
      assert.equal(report.status, 'pass')
      assert.equal(report.summary.checked, 1)
      assert.deepEqual(report.findings, [])
      assert.equal(report.replay.deliveries[0].finalStatus, 201)
    })
  }
})

test('a raw-distinct script id with the same report spelling names the ambiguity on either side', async () => {
  const marked = `foo${String.fromCharCode(0x200e)}bar`
  for (const [eventId, scriptId] of [[marked, 'foo bar'], ['foo bar', marked]]) {
    await withPlan(cleanPlan({
      receiver: { id: 'orders', url: RECEIVER_URL, script: [{ event: scriptId, statuses: [201] }] },
      events: [{ id: eventId, payload: {} }],
    }), async (planPath) => {
      const result = await cli(['--plan', planPath, '--json'])
      const report = JSON.parse(result.stdout)
      const finding = report.findings.find((item) => item.ruleId === 'plan-invalid' && item.location.pointer === '/receiver/script')
      assert.equal(result.code, 2)
      assert.equal(report.status, 'incomplete')
      assert.equal(report.summary.checked, 0)
      assert.ok(finding)
      assert.match(finding.message, /distinct raw event id at \/events\/0\/id renders identically/)
      assert.equal(finding.message.includes('which no event in this plan declares'), false)
      assert.equal(result.stdout.includes(String.fromCharCode(0x200e)), false)
    })
  }
})

test('a truly absent script event id keeps the undeclared-event diagnosis', async () => {
  await withPlan(cleanPlan({
    receiver: { id: 'orders', url: RECEIVER_URL, script: [{ event: 'ghost', statuses: [201] }] },
  }), async (planPath) => {
    const result = await cli(['--plan', planPath, '--json'])
    const report = JSON.parse(result.stdout)
    const finding = report.findings.find((item) => item.ruleId === 'plan-invalid' && item.location.pointer === '/receiver/script')
    assert.equal(result.code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.checked, 0)
    assert.ok(finding)
    assert.match(finding.message, /which no event in this plan declares/)
    assert.equal(finding.message.includes('renders identically'), false)
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
