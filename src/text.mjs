/**
 * webhook-replay-harness -- text handling for everything untrusted.
 *
 * A fixture is untrusted input. Its event ids, types, URLs, header names and
 * file paths all reach the report, and every one of them goes through
 * `sanitize` first. Nothing here touches the filesystem, the clock, the locale
 * or the network.
 */

/**
 * Order by UTF-16 code unit.
 *
 * Never a locale-aware comparison, under any of its spellings: collation
 * depends on the ICU data compiled into whatever Node build happens to run, and
 * every spelling of it drifts the same way. `Z` must precede `a`, `a-b` must
 * precede `a_b`, and `README` must precede `assets`, on every machine, for ever.
 */
export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * The characters removed from every untrusted string before it reaches output.
 *
 * Written as escapes rather than literally, because a literal U+2028 inside a
 * module is a hazard of its own. Five classes, each for a reason a reader of
 * the report would care about:
 *
 * - C0 and DEL. A newline forges a report line and an ESC opens a terminal
 *   escape sequence.
 * - C1, half-forgotten and twice as dangerous: U+0085 NEL is a line break to a
 *   great many readers and U+009B is the 8-bit form of CSI, so it opens a
 *   terminal control sequence with no ESC in sight.
 * - The line and paragraph separators.
 * - The bidirectional formatting characters. U+202E RIGHT-TO-LEFT OVERRIDE
 *   reverses everything displayed after it, so an event id can be made to read
 *   as something else entirely while the bytes say otherwise.
 *
 * This is applied to identifiers, not only to excerpts. An event id carrying
 * U+0085 forges a report line exactly as well as a payload excerpt would, and
 * an id is the field this tool prints most.
 */
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u200E\u200F\u202A-\u202E\u2066-\u2069]/g

export const TEXT_LIMIT = 160

/**
 * A bounded, single-line, control-free rendering of an untrusted string.
 *
 * Every removed character becomes a space rather than vanishing, so two ids
 * that differ only by a stripped character do not silently become the same
 * string in the report.
 */
export function sanitize(value, limit = TEXT_LIMIT) {
  const flattened = String(value).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  if (flattened.length <= limit) return flattened
  return `${flattened.slice(0, limit)}...`
}

/**
 * Decode bytes as UTF-8, strictly.
 *
 * `fatal: true` is the entire point. Decoding leniently and then hunting for a
 * replacement character cannot tell undecodable bytes from a fixture that
 * legitimately contains one, and that confusion is exactly how an unreadable
 * input comes to report a pass. Every byte source in this tool goes through
 * here, the plan file included -- a tool that hardens its data path and leaves
 * its own configuration path lossy has hardened nothing.
 */
export function decodeUtf8(bytes) {
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) }
  } catch {
    return { ok: false, reason: 'not-utf8' }
  }
}

const encoder = new TextEncoder()

/** UTF-8 byte length of a value's JSON encoding, or null when it has none. */
export function jsonByteLength(value) {
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    return null
  }
  if (text === undefined) return null
  return encoder.encode(text).length
}

/**
 * Whether a value nests deeper than `maxDepth`.
 *
 * Iterative on an explicit stack: a recursive walk over a fixture built to
 * nest ten thousand deep would exhaust the call stack, which is the failure
 * this limit exists to replace with a finding. A scalar has depth 0.
 */
export function exceedsDepth(value, maxDepth) {
  const stack = [{ node: value, depth: 0 }]
  while (stack.length > 0) {
    const { node, depth } = stack.pop()
    if (node === null || typeof node !== 'object') continue
    if (depth + 1 > maxDepth) return true
    if (Array.isArray(node)) {
      for (const child of node) stack.push({ node: child, depth: depth + 1 })
    } else {
      for (const key of Object.keys(node)) stack.push({ node: node[key], depth: depth + 1 })
    }
  }
  return false
}

/**
 * Join a declared root and a declared relative path into one display path.
 *
 * Both halves come from the plan, both are already known to be relative, and
 * the result is only ever a label: it is never resolved, opened, or compared
 * against a real path. Containment is decided on real paths elsewhere.
 */
export function joinRelative(root, file) {
  const left = String(root).replace(/^\.\/+/, '').replace(/\/+$/, '')
  const right = String(file).replace(/^\.\/+/, '')
  if (left === '' || left === '.') return right
  return `${left}/${right}`
}
