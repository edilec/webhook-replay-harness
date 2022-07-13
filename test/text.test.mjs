import assert from 'node:assert/strict'
import test from 'node:test'

import { TEXT_LIMIT, byCodeUnit, decodeUtf8, exceedsDepth, joinRelative, jsonByteLength, sanitize } from '../src/text.mjs'

/**
 * The hostile characters are built from their code points rather than written
 * into this file. A literal U+2028 or U+202E in a source file is a hazard in
 * its own right, and a reviewer cannot see it to check it.
 */
const CLASSES = [
  ['C0 NUL', 0x0000],
  ['C0 line feed', 0x000a],
  ['C0 carriage return', 0x000d],
  ['C0 ESC', 0x001b],
  ['C0 unit separator', 0x001f],
  ['DEL', 0x007f],
  ['C1 padding character', 0x0080],
  ['C1 NEL, which is a line break to many readers', 0x0085],
  ['C1 CSI, the 8-bit control sequence introducer', 0x009b],
  ['C1 APC', 0x009f],
  ['line separator', 0x2028],
  ['paragraph separator', 0x2029],
  ['left-to-right mark', 0x200e],
  ['right-to-left mark', 0x200f],
  ['left-to-right embedding', 0x202a],
  ['right-to-left override, which reverses displayed text', 0x202e],
  ['left-to-right isolate', 0x2066],
  ['pop directional isolate', 0x2069],
]

test('every documented control class is stripped from an untrusted string', () => {
  for (const [name, code] of CLASSES) {
    const hostile = `evt${String.fromCharCode(code)}one`
    const cleaned = sanitize(hostile)

    assert.equal(cleaned.includes(String.fromCharCode(code)), false, `${name} (U+${code.toString(16)}) survived sanitisation`)
    assert.equal(cleaned, 'evt one', `${name} must become a space, not disappear`)
  }
})

test('a stripped character becomes a space, so two ids do not collapse into one', () => {
  const forged = `a${String.fromCharCode(0x0085)}b`
  assert.equal(sanitize(forged), 'a b')
  assert.notEqual(sanitize(forged), 'ab', 'deleting the character would merge two distinct ids')
})

/**
 * A stripped character at either end leaves a space behind, and a leading space
 * in a printed line shifts every column after it -- so the flattened string is
 * trimmed as well as collapsed. `evt_1` and ` evt_1` must not be two readings
 * of the same id.
 */
test('a stripped character at either end leaves no space behind', () => {
  const nel = String.fromCharCode(0x0085)

  assert.equal(sanitize(`${nel}evt_1${nel}`), 'evt_1')
  assert.equal(sanitize('  evt_1  '), 'evt_1')
  assert.equal(sanitize(`${nel}  evt_1`), 'evt_1')
  assert.equal(sanitize(`evt_1${String.fromCharCode(0x202e)}`), 'evt_1')
})

test('ordinary text, including non-ASCII, is left alone', () => {
  assert.equal(sanitize('evt_order-created.42'), 'evt_order-created.42')
  assert.equal(sanitize('facturé-中文'), 'facturé-中文')
})

test('an over-long string is bounded and marked, never silently cut', () => {
  const long = 'x'.repeat(TEXT_LIMIT + 50)
  const cleaned = sanitize(long)

  assert.equal(cleaned.length, TEXT_LIMIT + 3)
  assert.equal(cleaned.endsWith('...'), true)
  assert.equal(sanitize('short', 4), 'shor...')
})

test('decoding is the decoder decision, never an inference from decoded text', () => {
  const valid = new TextEncoder().encode('{"id":"evt_1"}')
  assert.deepEqual(decodeUtf8(valid), { ok: true, text: '{"id":"evt_1"}' })

  // A document that legitimately contains U+FFFD decodes fine. Inferring
  // "not UTF-8" from a replacement character in the output is how an
  // unreadable input comes to report a pass.
  const literalReplacement = new TextEncoder().encode(`{"id":"${String.fromCharCode(0xfffd)}"}`)
  assert.equal(decodeUtf8(literalReplacement).ok, true)

  const invalid = Uint8Array.from([0x7b, 0xff, 0xfe, 0x7d])
  assert.deepEqual(decodeUtf8(invalid), { ok: false, reason: 'not-utf8' })
})

test('code-unit ordering disagrees with an English collator wherever they differ', () => {
  const collator = new Intl.Collator('en')
  for (const [left, right] of [['Z', 'a'], ['a-b', 'a_b'], ['README', 'assets'], ['URLS', 'URL_ENTRIES']]) {
    assert.equal(byCodeUnit(left, right), -1, `${left} must precede ${right} by code unit`)
    assert.equal(collator.compare(left, right) > 0, true, `the collator puts ${right} first, which is the disagreement being pinned`)
  }
  assert.equal(byCodeUnit('same', 'same'), 0)
})

test('depth is measured iteratively, so a deep fixture is a finding and not a stack overflow', () => {
  assert.equal(exceedsDepth('scalar', 0), false)
  assert.equal(exceedsDepth({ a: 1 }, 1), false)
  assert.equal(exceedsDepth({ a: { b: 1 } }, 1), true)
  assert.equal(exceedsDepth([[[1]]], 3), false)
  assert.equal(exceedsDepth([[[1]]], 2), true)

  let deep = 'leaf'
  for (let index = 0; index < 20000; index += 1) deep = { next: deep }
  assert.equal(exceedsDepth(deep, 16), true, 'and it answers rather than throwing')
})

test('payload size is measured in UTF-8 bytes, not characters', () => {
  assert.equal(jsonByteLength({ a: 1 }), 7)
  assert.equal(jsonByteLength('中'), 5, 'three payload bytes plus two quotes')
  assert.equal(jsonByteLength(undefined), null)

  const circular = {}
  circular.self = circular
  assert.equal(jsonByteLength(circular), null)
})

test('display paths are joined without ever being resolved', () => {
  assert.equal(joinRelative('events', 'a.json'), 'events/a.json')
  assert.equal(joinRelative('./events/', './a.json'), 'events/a.json')
  assert.equal(joinRelative('', 'a.json'), 'a.json')
  assert.equal(joinRelative('.', 'nested/a.json'), 'nested/a.json')
})
