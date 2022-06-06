import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { replayPlan } from '../src/index.mjs'

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/webhook-replay-harness.mjs')
const NEWLINE = String.fromCharCode(10)
const RECEIVER_URL = 'http://127.0.0.1:8787/hooks/orders'

/**
 * Sanitisation, checked where it is usually missing: the identifiers.
 *
 * Stripping the C0 range and the line and paragraph separators from an excerpt
 * field is not sanitising. The C1 range forges lines just as well -- U+0085 is
 * a line break to a great many readers and U+009B is the 8-bit control sequence
 * introducer -- and U+202E reverses everything displayed after it. And the
 * field a reader of this report sees most is not an excerpt: it is an event id,
 * which arrives straight from the fixture.
 *
 * So every class below is driven through the real report path *inside an event
 * id*, and checked in the captured delivery, the receiver log, the finding
 * message and the human summary alike.
 */
const CLASSES = [
  ['C0 NUL', 0x0000],
  ['C0 line feed', 0x000a],
  ['C0 ESC', 0x001b],
  ['DEL', 0x007f],
  ['C1 NEL', 0x0085],
  ['C1 CSI', 0x009b],
  ['C1 APC', 0x009f],
  ['line separator', 0x2028],
  ['paragraph separator', 0x2029],
  ['right-to-left mark', 0x200f],
  ['right-to-left override', 0x202e],
  ['first strong isolate', 0x2068],
]

function planWithId(id, overrides = {}) {
  return {
    receiver: { id: 'orders', url: RECEIVER_URL, dedupe: true, ...overrides.receiver },
    events: [{ id, payload: { ok: true } }, { id, payload: { ok: true } }],
  }
}

test('a hostile character in an event id never reaches the capture, the log or a finding', async () => {
  for (const [name, code] of CLASSES) {
    const character = String.fromCharCode(code)
    const report = await replayPlan(planWithId(`evt${character}one`))

    assert.equal(report.findings.length, 1, `${name}: the fixture must still raise its finding`)
    for (const value of [
      report.replay.deliveries[0].eventId,
      report.replay.deliveries[1].eventId,
      report.replay.receiverLog[0].eventId,
      report.replay.receiverLog[1].eventId,
      report.findings[0].message,
      report.findings[0].evidence,
    ]) {
      assert.equal(value.includes(character), false, `${name} (U+${code.toString(16)}) survived into the report`)
    }
    assert.equal(report.replay.deliveries[0].eventId, 'evt one', `${name}: the id is still readable`)
  }
})

test('a hostile character in the receiver id is stripped too', async () => {
  for (const [name, code] of CLASSES) {
    const character = String.fromCharCode(code)
    const report = await replayPlan({
      receiver: { id: `orders${character}eu`, url: RECEIVER_URL },
      events: [{ id: 'evt_1', payload: {} }],
    })

    assert.equal(report.replay.receiver.id.includes(character), false, `${name} survived in the receiver id`)
    assert.equal(report.replay.receiver.id, 'orders eu')
  }
})

test('a hostile character in the report label is stripped', async () => {
  for (const [, code] of CLASSES) {
    const character = String.fromCharCode(code)
    const report = await replayPlan(
      { receiver: { id: 'orders', url: RECEIVER_URL }, events: [{ id: 'evt_1', target: 'https://hooks.example.com/x', payload: {} }] },
      { label: `plans${character}live.json` },
    )

    assert.equal(report.findings[0].location.file.includes(character), false)
    assert.equal(report.findings[0].location.file, 'plans live.json')
  }
})

test('an event type and a target are sanitised on their way into the report', async () => {
  const report = await replayPlan({
    receiver: { id: 'orders', url: RECEIVER_URL },
    events: [{ id: 'evt_1', type: `order${String.fromCharCode(0x202e)}created`, payload: {} }],
  })

  assert.equal(report.replay.deliveries[0].type, 'order created')
})

/**
 * The consequence a reader would actually suffer: a forged line in the human
 * report. The id below carries a real line feed and a plausible-looking ERROR
 * line after it; if the id were printed as it arrived, the summary would gain a
 * line claiming a rule that does not exist.
 */
test('an event id cannot forge a line in the human summary', async () => {
  const base = await mkdtemp(join(tmpdir(), 'webhook-replay-harness-sanitise-'))
  try {
    const forged = `evt_1${NEWLINE}ERROR   forged.json/ fabricated-rule This line was written by the fixture.`
    const planPath = join(base, 'plan.json')
    await writeFile(planPath, JSON.stringify({
      receiver: { id: 'orders', url: RECEIVER_URL, dedupe: true },
      events: [{ id: forged, payload: {} }, { id: forged, payload: {} }],
    }))

    let stderr
    try {
      ({ stderr } = await run(process.execPath, [CLI, '--plan', planPath], { cwd: projectDirectory }))
    } catch (error) {
      stderr = error.stderr
    }

    const lines = stderr.split(NEWLINE).filter((line) => line !== '')
    assert.equal(lines.length, 5, 'four summary lines and exactly one finding line')
    assert.equal(lines.filter((line) => line.includes('fabricated-rule')).length, 1, 'the text survives as text')
    assert.equal(lines.some((line) => line.startsWith('ERROR   forged.json')), false, 'but never as a line of its own')
    assert.equal(lines[4].startsWith('WARNING'), true, 'the one real finding line is the deduplication warning')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('the CLI label is sanitised before it is printed as a location', async () => {
  const base = await mkdtemp(join(tmpdir(), 'webhook-replay-harness-label-'))
  try {
    const planPath = join(base, 'plan.json')
    await writeFile(planPath, JSON.stringify({
      receiver: { id: 'orders', url: RECEIVER_URL },
      events: [{ id: 'evt_1', target: 'https://hooks.example.com/x', payload: {} }],
    }))

    const forgedLabel = `plan.json${String.fromCharCode(0x0085)}INFO    all clear`
    let stdout
    let stderr
    try {
      ({ stdout, stderr } = await run(process.execPath, [CLI, '--plan', planPath, '--label', forgedLabel], { cwd: projectDirectory }))
    } catch (error) {
      ({ stdout, stderr } = error)
    }

    const report = JSON.parse(stdout)
    assert.equal(report.findings[0].location.file.includes(String.fromCharCode(0x0085)), false)
    assert.equal(report.findings[0].location.file, 'plan.json INFO all clear')
    assert.equal(stderr.includes(String.fromCharCode(0x0085)), false, 'and the C1 character never reaches a terminal')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('an unknown plan key carrying a control character is reported without carrying it', async () => {
  const report = await replayPlan({
    receiver: { id: 'orders', url: RECEIVER_URL },
    events: [{ id: 'evt_1', payload: {} }],
    [`ordering${String.fromCharCode(0x009b)}31m`]: 'fixture',
  })
  const finding = report.findings.find((item) => item.ruleId === 'plan-unknown-key')

  assert.equal(finding.location.pointer.includes(String.fromCharCode(0x009b)), false, 'a key becomes a pointer, and a pointer is printed')
  assert.equal(finding.location.pointer, '/ordering 31m')
  assert.equal(finding.message.includes(String.fromCharCode(0x009b)), false)
})

test('an unknown rule id is refused rather than defaulted to a severity', async () => {
  const { createFinding } = await import('../src/rules.mjs')

  assert.throws(
    () => createFinding({ ruleId: 'invented-rule', severity: 'info', message: 'x', file: 'p', pointer: '/' }),
    /is not in RULE_SEVERITY/,
  )
})
