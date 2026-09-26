import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { CREDENTIAL_HEADERS, DEFAULT_LIMITS, ORDERINGS, RULE_SEVERITY, sortFindings } from '../src/index.mjs'

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/webhook-replay-harness.mjs')
const NEWLINE = String.fromCharCode(10)
const RECEIVER_URL = 'http://127.0.0.1:8787/hooks/orders'

/**
 * The finding order, pinned at every key that decides it.
 *
 * Scanning the source for a comparator name proves nothing: `Intl.Collator`
 * collates like `localeCompare` and spells like neither, and either of them can
 * be substituted at one call site at a time. What follows drives strings whose
 * collation order differs from their code-unit order through the real binary,
 * and pins the exact sequence the report emits.
 *
 * The values are chosen for their disagreements: `Z` sorts before `a` by code
 * unit (0x5A before 0x61) and after it by English collation, and `a-b` sorts
 * before `a_b` by code unit (0x2D before 0x5F) and after it by collation.
 * `the closed alphabets below` names the sites where no such value exists.
 */

const DISAGREE = ['Z', 'a', 'a-b', 'a_b']

async function withPlan(body, use) {
  const base = await mkdtemp(join(tmpdir(), 'webhook-replay-harness-order-'))
  try {
    const planPath = join(base, 'plan.json')
    await writeFile(planPath, JSON.stringify(body, null, 2))
    return await use(planPath)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

async function cli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd: projectDirectory })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

test('an English collator really does order these strings the other way', () => {
  const collator = new Intl.Collator('en')

  assert.equal([...DISAGREE].sort((left, right) => collator.compare(left, right)).join(' '), 'a a_b a-b Z')
  assert.equal([...DISAGREE].sort().join(' '), 'Z a a-b a_b', 'otherwise the tests below would prove nothing')
})

/**
 * `location.pointer`, which carries arbitrary user text: an unknown plan key
 * becomes the pointer of the finding that refuses it.
 */
test('findings order by pointer in code units, through the real binary', async () => {
  await withPlan(
    {
      receiver: { id: 'orders', url: RECEIVER_URL },
      events: [{ id: 'evt_1', payload: {} }],
      Z: 1,
      a: 1,
      'a-b': 1,
      'a_b': 1,
    },
    async (planPath) => {
      const { code, stdout } = await cli(['--plan', planPath, '--label', 'plan.json', '--json'])
      const report = JSON.parse(stdout)

      assert.equal(code, 2)
      assert.deepEqual(report.findings.map((finding) => finding.location.pointer), [
        '/Z',
        '/a',
        '/a-b',
        '/a_b',
        '/events',
      ])
    },
  )
})

/**
 * `message`, which carries arbitrary user text too: a script rule naming an
 * event the plan never declares quotes that id into the message. All four
 * findings share a file, a pointer and a rule id, so the message is the key
 * that decides their order.
 */
test('findings order by message in code units, through the real binary', async () => {
  await withPlan(
    {
      receiver: {
        id: 'orders',
        url: RECEIVER_URL,
        script: DISAGREE.map((event) => ({ event, statuses: [200] })),
      },
      events: [{ id: 'evt_1', payload: {} }],
    },
    async (planPath) => {
      const { code, stdout, stderr } = await cli(['--plan', planPath, '--label', 'plan.json'])
      const report = JSON.parse(stdout)
      const scripted = report.findings.filter((finding) => finding.location.pointer === '/receiver/script')

      assert.equal(code, 2)
      assert.equal(scripted.length, 4)
      assert.equal(
        scripted[0].message,
        'Script rule names event "Z", which no event in this plan declares, so the statuses it scripts would never be used.',
      )
      assert.deepEqual(scripted.map((finding) => finding.message.split('"')[1]), ['Z', 'a', 'a-b', 'a_b'])

      // And the human summary prints them in that same order, line by line.
      const printed = stderr.split(NEWLINE).filter((line) => line.includes('Script rule names event'))
      assert.deepEqual(printed.map((line) => line.split('"')[1]), ['Z', 'a', 'a-b', 'a_b'])
    },
  )
})

/**
 * Both keys at once, in one report, with the whole emitted sequence written
 * out: nine findings, in the one order this tool is allowed to produce.
 */
test('a report mixing both keys emits exactly one sequence', async () => {
  await withPlan(
    {
      receiver: {
        id: 'orders',
        url: RECEIVER_URL,
        script: DISAGREE.map((event) => ({ event, statuses: [200] })),
      },
      events: [],
      Z: 1,
      a: 1,
      'a-b': 1,
      'a_b': 1,
    },
    async (planPath) => {
      const { stdout } = await cli(['--plan', planPath, '--label', 'plan.json', '--json'])
      const report = JSON.parse(stdout)

      assert.deepEqual(
        report.findings.map((finding) => `${finding.location.pointer} ${finding.message.split('"')[1] ?? ''}`),
        [
          '/Z Z',
          '/a a',
          '/a-b a-b',
          '/a_b a_b',
          '/events ',
          '/receiver/script Z',
          '/receiver/script a',
          '/receiver/script a-b',
          '/receiver/script a_b',
        ],
      )
    },
  )
})

/**
 * `location.file` and `evidence`, pinned on the exported sorter.
 *
 * A single report labels every finding with the same plan, and no two findings
 * in one report tie on file, pointer, rule id and message while differing in
 * evidence -- so neither key can be made to decide anything through the binary.
 * `sortFindings` is exported for callers that merge reports, where both keys do
 * decide, and this is the documented order it owes them.
 */
test('the exported sorter orders by file, then pointer, then rule id, then message, then evidence', () => {
  const finding = (file, pointer, ruleId, message, evidence) => ({
    ruleId,
    severity: 'error',
    message,
    location: { file, pointer },
    ...(evidence === undefined ? {} : { evidence }),
  })

  const byFile = sortFindings([
    finding('a_b.json', '/', 'plan-invalid', 'x'),
    finding('a-b.json', '/', 'plan-invalid', 'x'),
    finding('a.json', '/', 'plan-invalid', 'x'),
    finding('Z.json', '/', 'plan-invalid', 'x'),
  ])
  assert.deepEqual(byFile.map((item) => item.location.file), ['Z.json', 'a-b.json', 'a.json', 'a_b.json'])

  const byPointer = sortFindings([
    finding('plan.json', '/a_b', 'plan-invalid', 'x'),
    finding('plan.json', '/Z', 'plan-invalid', 'x'),
    finding('plan.json', '/a-b', 'plan-invalid', 'x'),
  ])
  assert.deepEqual(byPointer.map((item) => item.location.pointer), ['/Z', '/a-b', '/a_b'])

  const byRuleId = sortFindings([
    finding('plan.json', '/', 'plan-unknown-key', 'x'),
    finding('plan.json', '/', 'plan-invalid', 'x'),
  ])
  assert.deepEqual(byRuleId.map((item) => item.ruleId), ['plan-invalid', 'plan-unknown-key'])

  const byMessage = sortFindings([
    finding('plan.json', '/', 'plan-invalid', 'a_b'),
    finding('plan.json', '/', 'plan-invalid', 'Z'),
    finding('plan.json', '/', 'plan-invalid', 'a-b'),
  ])
  assert.deepEqual(byMessage.map((item) => item.message), ['Z', 'a-b', 'a_b'])

  const byEvidence = sortFindings([
    finding('plan.json', '/', 'plan-invalid', 'x', 'a_b'),
    finding('plan.json', '/', 'plan-invalid', 'x', 'Z'),
    finding('plan.json', '/', 'plan-invalid', 'x', 'a-b'),
    finding('plan.json', '/', 'plan-invalid', 'x'),
  ])
  assert.deepEqual(byEvidence.map((item) => item.evidence ?? ''), ['', 'Z', 'a-b', 'a_b'])
})

/**
 * The sites no fixture can pin, and the reason.
 *
 * Three ordered lists reach output over a closed alphabet: the rule ids a
 * finding carries, the credential header names a refusal quotes, and the limit
 * names an unknown-limit message lists. Over `[a-z0-9-]` and over these
 * particular camel-case names, an English collator agrees with code units on
 * every ordered pair -- so substituting one for the other at those sites
 * changes no output anywhere, and no fixture could show that it had.
 *
 * This test is the proof, and it is also the alarm: add a rule id, a header
 * name or a limit whose collation disagrees, and the site stops being
 * unpinnable and this test says so.
 */
test('the closed alphabets that reach output collate exactly as their code units do', () => {
  const collator = new Intl.Collator('en')
  const sign = (value) => (value < 0 ? -1 : value > 0 ? 1 : 0)

  const disagreements = (values) => {
    const found = []
    let pairs = 0
    for (const left of values) {
      for (const right of values) {
        if (left === right) continue
        pairs += 1
        const byCodeUnit = left < right ? -1 : 1
        if (byCodeUnit !== sign(collator.compare(left, right))) found.push(`${left} vs ${right}`)
      }
    }
    return { pairs, found }
  }

  const ruleIds = disagreements(Object.keys(RULE_SEVERITY))
  assert.equal(ruleIds.pairs, 702)
  assert.deepEqual(ruleIds.found, [])

  const headers = disagreements([...CREDENTIAL_HEADERS])
  assert.equal(headers.pairs, 110)
  assert.deepEqual(headers.found, [])

  const limits = disagreements(Object.keys(DEFAULT_LIMITS))
  assert.equal(limits.pairs, 42)
  assert.deepEqual(limits.found, [])

  const orderings = disagreements([...ORDERINGS])
  assert.equal(orderings.pairs, 2)
  assert.deepEqual(orderings.found, [])

  // The method finds disagreements where there are some: Z against each of
  // the three lower-case values, both ways, and a-b against a_b, both ways.
  assert.equal(disagreements(DISAGREE).pairs, 12)
  assert.equal(disagreements(DISAGREE).found.length, 8)
})
