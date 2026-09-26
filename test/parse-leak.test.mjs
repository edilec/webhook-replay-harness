import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { parseFailureDetail } from '../src/index.mjs'

/**
 * Sanitisation on the path where it was not sufficient.
 *
 * Both JSON reads -- the plan file and every fixture file -- already wrapped
 * their parse error in `sanitize`, and both still published the document. V8
 * reports a parse failure two ways, and one of them quotes the input back:
 * `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON` is the whole
 * document when it is short, and a window around the offence when it is not.
 * `sanitize` replaces control characters and cuts from the END, so a quoted
 * span at the FRONT passes through it untouched and well inside the limit.
 *
 * A fixture is other people's webhook traffic and a plan names the endpoints it
 * is replayed against; the document that fails to parse is the one nothing has
 * validated. Both reached the JSON report on stdout.
 *
 * The canary is AWS's own published documentation placeholder, not a
 * credential. It is checked down to eight characters, because half a leak is
 * still a leak.
 */

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/webhook-replay-harness.mjs')
const CANARY = 'AKIAIOSFODNN7EXAMPLE'
const SHORTEST_PREFIX = 8

function runCli(argv) {
  return new Promise((fulfil) => {
    execFile(
      process.execPath,
      [CLI, ...argv],
      { cwd: projectDirectory, encoding: 'utf8' },
      (error, stdout, stderr) => {
        fulfil({ code: error === null ? 0 : error.code, stdout, stderr })
      },
    )
  })
}

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'webhook-replay-harness-leak-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(directory, 'events'), { recursive: true })
  return directory
}

function planFor(files) {
  return JSON.stringify({
    receiver: {
      id: 'orders-receiver',
      transport: 'in-process',
      url: 'http://127.0.0.1:8787/hooks/orders',
      defaultStatus: 200,
    },
    allowedHosts: ['127.0.0.1'],
    ordering: 'fixture',
    clock: { startMs: 0 },
    delivery: { maxAttempts: 1, backoffMs: 10, backoffFactor: 2, maxBackoffMs: 100 },
    eventsRoot: 'events',
    events: files.map((file, index) => ({ id: `evt_${index}`, type: 'order.created', file })),
  })
}

function assertNoCanary(stream, where) {
  for (let length = CANARY.length; length >= SHORTEST_PREFIX; length -= 1) {
    const prefix = CANARY.slice(0, length)
    assert.ok(
      !stream.includes(prefix),
      `${where} carries ${length} characters of the canary: ${JSON.stringify(stream)}`,
    )
  }
}

test('a fixture that is nothing but a credential is not echoed by either report', async (t) => {
  const directory = await workspace(t)
  await writeFile(join(directory, 'events', 'bad.json'), CANARY)
  await writeFile(join(directory, 'plan.json'), planFor(['bad.json']))

  for (const extra of [[], ['--json']]) {
    const result = await runCli(['--plan', join(directory, 'plan.json'), ...extra])
    assertNoCanary(result.stdout, `stdout for ${JSON.stringify(extra)}`)
    assertNoCanary(result.stderr, `stderr for ${JSON.stringify(extra)}`)
  }
})

test('a plan that is nothing but a credential is not echoed by either report', async (t) => {
  const directory = await workspace(t)
  await writeFile(join(directory, 'plan.json'), CANARY)

  for (const extra of [[], ['--json']]) {
    const result = await runCli(['--plan', join(directory, 'plan.json'), ...extra])
    assertNoCanary(result.stdout, `stdout for ${JSON.stringify(extra)}`)
    assertNoCanary(result.stderr, `stderr for ${JSON.stringify(extra)}`)
  }
})

test('a credential inside a broken fixture is not echoed either', async (t) => {
  const directory = await workspace(t)
  // V8 quotes a WINDOW around the offence, not only the head of the file, so a
  // secret in the middle of a broken fixture leaks just as readily.
  await writeFile(join(directory, 'events', 'bad.json'), `{"orderId": "A-1", "token": ${CANARY}}`)
  await writeFile(join(directory, 'plan.json'), planFor(['bad.json']))

  const result = await runCli(['--plan', join(directory, 'plan.json'), '--json'])
  assertNoCanary(result.stdout, 'stdout')
  assertNoCanary(result.stderr, 'stderr')
})

test('a document that merely CONTAINS "at position" does not smuggle itself through', async (t) => {
  // Looking for `at position` before recognising the quoting shape would keep
  // the quoted span whenever the document supplied that phrase itself.
  const directory = await workspace(t)
  await writeFile(join(directory, 'plan.json'), `${CANARY} at position 9 (line 1 column 10)`)

  const result = await runCli(['--plan', join(directory, 'plan.json'), '--json'])
  assertNoCanary(result.stdout, 'stdout')
  assertNoCanary(result.stderr, 'stderr')
  assert.match(result.stdout, /unexpected token 'A'/)
})

test('both findings still say what was wrong and where', async (t) => {
  const directory = await workspace(t)
  await writeFile(join(directory, 'events', 'bad.json'), '{"a": 1 "b": 2}')
  await writeFile(join(directory, 'plan.json'), planFor(['bad.json']))

  const fixture = await runCli(['--plan', join(directory, 'plan.json'), '--json'])
  const fixtureFinding = JSON.parse(fixture.stdout).findings.find(
    (entry) => entry.ruleId === 'event-file-not-json',
  )
  assert.ok(fixtureFinding !== undefined, 'the fixture was refused as invalid JSON')
  // A diagnostic that says nothing is a different defect: position, line and
  // column are V8's useful half and none of them is document content.
  assert.match(fixtureFinding.message, /at position 8 \(line 1 column 9\)/)

  await writeFile(join(directory, 'plan.json'), '{"receiver": {} "events": []}')
  const plan = await runCli(['--plan', join(directory, 'plan.json'), '--json'])
  const planFinding = JSON.parse(plan.stdout).findings.find(
    (entry) => entry.ruleId === 'plan-not-json',
  )
  assert.ok(planFinding !== undefined, 'the plan was refused as invalid JSON')
  assert.match(planFinding.message, /at position 16 \(line 1 column 17\)/)
})

test('parseFailureDetail keeps the position and drops the quoted document', () => {
  const cases = [
    [CANARY, "unexpected token 'A'"],
    [`{"a": ${CANARY}}`, "unexpected token 'A'"],
    ['ssn 123-45-6789', "unexpected token 's'"],
    [
      '{"a": 1 "b": 2}',
      "Expected ',' or '}' after property value in JSON at position 8 (line 1 column 9)",
    ],
    [`{"a":"${CANARY}`, 'Unterminated string in JSON at position 26 (line 1 column 27)'],
    ['', 'Unexpected end of JSON input'],
  ]
  for (const [text, expected] of cases) {
    try {
      JSON.parse(text)
      assert.fail(`${JSON.stringify(text)} was supposed to be unparseable`)
    } catch (error) {
      assert.equal(parseFailureDetail(error), expected)
    }
  }
})

test('a non-Error, and an error with no message, still produce a usable detail', () => {
  assert.equal(parseFailureDetail(undefined), 'it could not be parsed as JSON')
  assert.equal(parseFailureDetail({}), 'it could not be parsed as JSON')
  assert.equal(parseFailureDetail(new Error('')), 'it could not be parsed as JSON')
})
