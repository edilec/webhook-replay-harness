import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
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

/**
 * The safety property, proved rather than asserted.
 *
 * The strongest version of "nothing left this machine" is not a source scan: it
 * is a real listener, on a real loopback port, that the plan declares as its
 * receiver and that the fixtures target -- and which then records that nothing
 * ever knocked. If any code path in this tool opened a socket for a delivery,
 * the socket it would open is this one.
 */
async function withListener(body) {
  const seen = { connections: 0, requests: 0 }
  const server = createServer((request, response) => {
    seen.requests += 1
    response.statusCode = 200
    response.end('{}')
  })
  server.on('connection', () => {
    seen.connections += 1
  })

  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  try {
    return await body({ url: `http://127.0.0.1:${port}/hooks/orders`, seen, port })
  } finally {
    await new Promise((done) => server.close(done))
  }
}

async function withBase(body) {
  const base = await mkdtemp(join(tmpdir(), 'webhook-replay-harness-network-'))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

async function runCli(planPath) {
  try {
    const { stdout } = await run(process.execPath, [CLI, '--plan', planPath, '--json'], { cwd: projectDirectory })
    return { code: 0, report: JSON.parse(stdout) }
  } catch (error) {
    return { code: error.code, report: JSON.parse(error.stdout) }
  }
}

async function shippedSource() {
  const parts = []
  for (const directory of ['src', 'bin']) {
    for (const name of (await readdir(join(projectDirectory, directory))).sort()) {
      parts.push(await readFile(join(projectDirectory, directory, name), 'utf8'))
    }
  }
  return parts.join(String.fromCharCode(10))
}

test('a declared, live, loopback receiver is never actually contacted', async () => {
  await withListener(async ({ url, seen }) => {
    await withBase(async (base) => {
      const planPath = join(base, 'plan.json')
      await writeFile(planPath, JSON.stringify({
        receiver: { id: 'orders', url },
        events: [
          { id: 'evt_1', target: url, payload: { orderId: 'A-1' } },
          { id: 'evt_2', target: url, payload: { orderId: 'A-2' } },
        ],
      }))

      const { code, report } = await runCli(planPath)

      assert.equal(code, 0)
      assert.equal(report.summary.delivered, 2, 'both events were delivered')
      assert.equal(report.replay.receiver.transport, 'in-process')
      assert.equal(report.replay.receiverLog.length, 2, 'to a receiver in that process')
      assert.equal(seen.connections, 0, 'and the real listener on that exact port saw no connection at all')
      assert.equal(seen.requests, 0, 'and no request')
    })
  })
})

test('an external target is refused with no attempt constructed and no trace of the fixture body', async () => {
  const report = await replayPlan({
    receiver: { id: 'orders', url: 'http://127.0.0.1:8787/hooks/orders' },
    events: [{ id: 'evt_1', target: 'https://hooks.example.com/inbound', payload: { secretish: 'PAYLOAD_MARKER' } }],
  })

  assert.equal(report.summary.attempts, 0, 'no attempt was ever constructed')
  assert.equal(report.summary.refused, 1)
  assert.deepEqual(report.replay.receiverLog, [], 'the receiver never saw it either')
  assert.equal(report.replay.deliveries[0].attempts, 0)
  assert.equal(JSON.stringify(report).includes('PAYLOAD_MARKER'), false, 'and the payload is not echoed into the report')
  assert.equal(report.status, 'fail')
})

test('a refusal names the host without turning the fixture into an instruction', async () => {
  const report = await replayPlan({
    receiver: { id: 'orders', url: 'http://127.0.0.1:8787/hooks/orders' },
    events: [{ id: 'evt_1', target: 'https://hooks.example.com/inbound', payload: {} }],
  })
  const finding = report.findings[0]

  assert.equal(finding.ruleId, 'target-host-not-allowed')
  assert.equal(finding.evidence, 'https://hooks.example.com/inbound', 'quoted as evidence, never followed')
  assert.equal(finding.message.includes('nothing left this machine'), true)
})

test('the shipped source imports nothing that could open a socket', async () => {
  const source = await shippedSource()

  for (const name of [
    'node:net',
    'node:http',
    'node:https',
    'node:http2',
    'node:dgram',
    'node:dns',
    'node:tls',
    'node:cluster',
    'node:worker_threads',
    'XMLHttpRequest',
    'WebSocket',
    'EventSource',
    'navigator.sendBeacon',
  ]) {
    assert.equal(source.includes(name), false, `the source reaches for ${name}`)
  }
  assert.equal(/\bfetch\s*\(/.test(source), false, 'the source calls fetch')
  assert.equal(/\bnew\s+Request\b/.test(source), false)
})

test('the shipped source cannot shell out to something that would open one for it', async () => {
  const source = await shippedSource()

  for (const name of ['node:child_process', 'execFile', 'spawn(', 'execSync', 'node:vm']) {
    assert.equal(source.includes(name), false, `the source reaches for ${name}`)
  }
  assert.equal(/\beval\s*\(/.test(source), false)
  assert.equal(/\bnew\s+Function\b/.test(source), false)
})

test('the manifest declares no dependency of any kind', async () => {
  const manifest = JSON.parse(await readFile(join(projectDirectory, 'package.json'), 'utf8'))

  assert.equal(Object.hasOwn(manifest, 'dependencies'), false)
  assert.equal(Object.hasOwn(manifest, 'devDependencies'), false)
  assert.equal(Object.hasOwn(manifest, 'peerDependencies'), false)
  assert.equal(Object.hasOwn(manifest, 'optionalDependencies'), false)
})
