import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
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
const DENY_NETWORK = join(projectDirectory, 'test/deny-network.mjs')

async function withBase(body) {
  const base = await mkdtemp(join(tmpdir(), 'webhook-replay-harness-network-'))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

async function runCli(planPath, preload = null) {
  try {
    const args = [...(preload === null ? [] : ['--import', preload]), CLI, '--plan', planPath, '--json']
    const { stdout } = await run(process.execPath, args, { cwd: projectDirectory })
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

async function listenerTestSources(directory) {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.mjs')).sort()
  const forbidden = [
    /\bcreateServer\s*\(/,
    /\.listen\s*\(/,
  ]
  const offenders = []
  for (const name of names) {
    const source = await readFile(join(directory, name), 'utf8')
    if (forbidden.some((pattern) => pattern.test(source)) ||
      (name.endsWith('.test.mjs') && /\bfrom\s*['"]node:(?:net|http|https|tls|dgram)['"]/.test(source))) {
      offenders.push(name)
    }
  }
  return offenders
}

test('test-source guard detects a reintroduced loopback listener', async () => {
  await withBase(async (base) => {
    const name = 'unsafe.test.mjs'
    const source = `import { create${'Server'} } from 'node:${'http'}'\ncreate${'Server'}().lis${'ten'}(0)`
    await writeFile(join(base, name), source)
    assert.deepEqual(await listenerTestSources(base), [name])
  })
})

test('shipped tests never import or bind a listener', async () => {
  assert.deepEqual(await listenerTestSources(join(projectDirectory, 'test')), [])
})

test('offline preload denies even a host-free data URL fetch', async () => {
  let code = 0
  let stderr = ''
  try {
    await run(process.execPath, ['--import', DENY_NETWORK, '--input-type=module', '--eval', "await fetch('data:text/plain,probe')"], { cwd: projectDirectory })
  } catch (error) {
    code = error.code
    stderr = error.stderr
  }
  assert.notEqual(code, 0)
  assert.match(stderr, /OFFLINE_NETWORK_DENIED/)
})

test('two in-process deliveries complete under active offline network denial', async () => {
  await withBase(async (base) => {
    const planPath = join(base, 'plan.json')
    const url = 'http://127.0.0.1:8787/hooks/orders'
    await writeFile(planPath, JSON.stringify({
      receiver: { id: 'orders', url },
      events: [
        { id: 'evt_1', target: url, payload: { orderId: 'A-1' } },
        { id: 'evt_2', target: url, payload: { orderId: 'A-2' } },
      ],
    }))
    const { code, report } = await runCli(planPath, DENY_NETWORK)
    assert.equal(code, 0)
    assert.equal(report.status, 'pass')
    assert.equal(report.summary.delivered, 2)
    assert.equal(report.replay.receiver.transport, 'in-process')
    assert.equal(report.replay.receiverLog.length, 2)
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
