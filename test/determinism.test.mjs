import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { replayPlan, replayPlanFile } from '../src/index.mjs'

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLEAN_PLAN = join(projectDirectory, 'examples/clean/plan.json')
const BROKEN_PLAN = join(projectDirectory, 'examples/broken/plan.json')
const RECEIVER_URL = 'http://127.0.0.1:8787/hooks/orders'

/**
 * Ordering is pinned by what the tool emits, not by what its source says.
 *
 * Scanning the source for `.localeCompare(` is not a determinism test:
 * `Intl.Collator` collates identically and spells differently, so the scan
 * passes while the replay order silently becomes dependent on the ICU data of
 * whatever Node build is running. Every id below is chosen because code-unit
 * order and English collation disagree about it, so substituting one comparator
 * for the other changes the emitted order and these assertions fail.
 */
const DISAGREEING_IDS = ['Z', 'a', 'a-b', 'a_b', 'README', 'assets']
const CODE_UNIT_ORDER = ['README', 'Z', 'a', 'a-b', 'a_b', 'assets']

function planWith(ids, overrides = {}) {
  return {
    receiver: { id: 'orders', url: RECEIVER_URL },
    events: ids.map((id) => ({ id, payload: { id } })),
    ...overrides,
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

test('an English collator really does order these ids the other way', () => {
  const collator = new Intl.Collator('en')
  const collated = [...DISAGREEING_IDS].sort((left, right) => collator.compare(left, right))

  assert.notDeepEqual(collated, CODE_UNIT_ORDER, 'otherwise the ordering tests below would prove nothing')
  assert.deepEqual(collated, ['a', 'a_b', 'a-b', 'assets', 'README', 'Z'])
})

test('ordering by event id follows code units, through the real report path', async () => {
  const report = await replayPlan(planWith(DISAGREEING_IDS, { ordering: 'eventId' }))

  assert.deepEqual(report.replay.deliveries.map((item) => item.eventId), CODE_UNIT_ORDER)
  assert.deepEqual(report.replay.receiverLog.map((entry) => entry.eventId), CODE_UNIT_ORDER)
  assert.deepEqual(report.replay.deliveries.map((item) => item.order), [1, 2, 3, 4, 5, 6])
})

test('fixture ordering replays the declared order exactly, whatever the ids collate to', async () => {
  const declared = ['a', 'a_b', 'a-b', 'assets', 'README', 'Z']
  assert.notDeepEqual(declared, CODE_UNIT_ORDER, 'the declared order must differ from the code-unit one, or this proves nothing')

  const report = await replayPlan(planWith(declared, { ordering: 'fixture' }))

  assert.deepEqual(report.replay.deliveries.map((item) => item.eventId), declared)
})

test('the default ordering is the declared one, and it is recorded in the capture', async () => {
  const report = await replayPlan(planWith(['b', 'a']))

  assert.equal(report.replay.ordering, 'fixture')
  assert.deepEqual(report.replay.deliveries.map((item) => item.eventId), ['b', 'a'])
})

test('two events sharing an id keep their declared order when sorting by id', async () => {
  const report = await replayPlan({
    receiver: { id: 'orders', url: RECEIVER_URL, dedupe: true },
    ordering: 'eventId',
    events: [{ id: 'a', payload: { seq: 1 } }, { id: 'b', payload: { seq: 2 } }, { id: 'a', payload: { seq: 3 } }],
  })

  assert.deepEqual(report.replay.deliveries.map((item) => item.eventId), ['a', 'a', 'b'])
  assert.deepEqual(report.replay.deliveries.map((item) => item.outcome), ['delivered', 'deduplicated', 'delivered'])
})

/**
 * The ordering is not cosmetic: it decides which event survives a cut-off, and
 * therefore which event is replayed at all. Both ids below are ordered one way
 * by code unit and the other way by an English collator, so a substituted
 * comparator changes which event reaches the receiver.
 */
test('the event cut-off follows code units, not collation', async () => {
  const collator = new Intl.Collator('en')

  for (const [first, second] of [['Z', 'a'], ['README', 'assets'], ['a-b', 'a_b']]) {
    assert.equal(collator.compare(first, second) > 0, true, `a collator puts ${second} first, which is the disagreement being pinned`)

    const report = await replayPlan(planWith([second, first], { ordering: 'eventId' }), { limits: { maxEvents: 1 } })
    const replayed = report.replay.receiverLog.map((entry) => entry.eventId)
    const stopped = report.findings.filter((finding) => finding.ruleId === 'limit-events-exceeded')

    assert.deepEqual(replayed, [first], `the replay must reach ${first} and never ${second}`)
    assert.equal(stopped.length, 1)
    assert.equal(stopped[0].evidence, `first event not replayed: ${second}`)
    assert.equal(report.status, 'incomplete')
  }
})

test('findings are ordered by the documented key, not by the order they were raised', async () => {
  const report = await replayPlan({
    receiver: { id: 'orders', url: RECEIVER_URL },
    ordering: 'fixture',
    events: [
      { id: 'evt_9', target: 'https://hooks.example.com/x', payload: {} },
      { id: 'evt_1', target: 'ftp://127.0.0.1/x', payload: {} },
      { id: 'evt_5', target: 'http://127.0.0.1:9999/x', payload: {} },
    ],
  })

  // One file, so the pointer decides: /events/0, /events/1, /events/2 -- which
  // is the plan order, not the order the rules happened to fire in.
  assert.deepEqual(report.findings.map((finding) => finding.location.pointer), ['/events/0/target', '/events/1/target', '/events/2/target'])
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), [
    'target-host-not-allowed',
    'target-url-invalid',
    'target-not-declared-receiver',
  ])
})

test('the shipped examples replay identically every time', async () => {
  const clean = await replayPlanFile(CLEAN_PLAN, { label: 'clean' })
  const broken = await replayPlanFile(BROKEN_PLAN, { label: 'broken' })

  assert.equal(clean.status, 'pass')
  assert.equal(broken.status, 'fail')
  assert.equal(JSON.stringify(await replayPlanFile(CLEAN_PLAN, { label: 'clean' })), JSON.stringify(clean))
  assert.equal(JSON.stringify(await replayPlanFile(BROKEN_PLAN, { label: 'broken' })), JSON.stringify(broken))
  assert.notEqual(JSON.stringify(clean.findings), JSON.stringify(broken.findings))
  assert.equal(broken.findings.length > 5, true, 'the comparison is over a report with something in it')
})

/**
 * A secondary guard, and only that. The tests above are what pin the ordering:
 * a source scan cannot tell a comparator apart from its replacement, and
 * `Intl.Collator` is exactly that replacement. Both spellings are named here
 * because there is no legitimate use for either in a tool whose output must not
 * move with the ICU data of the Node build that happens to run it.
 */
test('the shipped source never reaches for a locale-aware comparison', async () => {
  const source = await shippedSource()

  assert.equal(source.includes('localeCompare'), false, 'localeCompare depends on ICU data that varies between Node builds')
  assert.equal(/\bIntl\b/.test(source), false, 'Intl.Collator drifts exactly as localeCompare does')
  assert.equal(/\btoLocale(?:Lower|Upper)Case\b/.test(source), false, 'locale-aware case folding drifts too')
})

test('the shipped source reads no clock, no random source and no environment', async () => {
  const source = await shippedSource()

  assert.equal(/\bnew\s+Date\b/.test(source), false, 'a wall clock in the output breaks byte-identical runs')
  assert.equal(/\bDate\.now\s*\(/.test(source), false)
  assert.equal(/\bMath\.random\s*\(/.test(source), false)
  assert.equal(/\bprocess\.env\b/.test(source), false)
  assert.equal(/\bperformance\.now\s*\(/.test(source), false)
  assert.equal(/\bhrtime\b/.test(source), false)
})

test('the shipped source sets no timer, so no replay can sleep', async () => {
  const source = await shippedSource()

  for (const name of ['setTimeout', 'setInterval', 'setImmediate', 'node:timers', 'Atomics.wait']) {
    assert.equal(source.includes(name), false, `the source reaches for ${name}, which would make virtual time a lie`)
  }
})

test('the shipped source never enumerates a directory', async () => {
  const source = await shippedSource()

  // Every fixture is named explicitly by the plan. Nothing is discovered by
  // listing a directory, so filesystem enumeration order cannot reach output.
  assert.equal(source.includes('readdir'), false)
  assert.equal(source.includes('opendir'), false)
  assert.equal(source.includes('glob'), false)
})
