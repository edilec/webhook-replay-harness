/**
 * webhook-replay-harness -- the rules, and the one table that pins them.
 *
 * Severity is the whole difference between a run that fails and one that
 * passes. Written as a literal at each construction site it drifts silently,
 * and demoting one refusal rule to a warning turns "this fixture would have
 * sent data off this machine" into a green build.
 *
 * So there is exactly one table, every finding takes its severity from it, and
 * an unknown rule id throws rather than defaulting. The table is the source of
 * truth -- it is not the test. `test/severity-exit.test.mjs` drives real
 * fixtures through the real binary and pins the exit codes, because three
 * declarations agreeing with each other can be edited together and an exit code
 * cannot be edited at all.
 */

import { TEXT_LIMIT, byCodeUnit, sanitize } from './text.mjs'

export const RULE_SEVERITY = Object.freeze({
  'delivery-exhausted-retries': 'error',
  'delivery-rejected-permanently': 'error',
  'delivery-retried': 'info',
  'duplicate-event-id-deduplicated': 'warning',
  'duplicate-event-id-redelivered': 'error',
  'event-file-not-json': 'error',
  'event-file-not-utf8': 'error',
  'event-file-outside-root': 'error',
  'event-file-unreadable': 'error',
  'event-header-credential': 'error',
  'limit-events-exceeded': 'error',
  'limit-findings-exceeded': 'error',
  'limit-payload-bytes-exceeded': 'error',
  'limit-payload-depth-exceeded': 'error',
  'limit-plan-bytes-exceeded': 'error',
  'limit-total-attempts-exceeded': 'error',
  'limit-virtual-time-exceeded': 'error',
  'no-events-replayed': 'error',
  'plan-invalid': 'error',
  'plan-not-json': 'error',
  'plan-not-utf8': 'error',
  'plan-unknown-key': 'error',
  'plan-unreadable': 'error',
  'receiver-not-declared-local': 'error',
  'target-host-not-allowed': 'error',
  'target-not-declared-receiver': 'error',
  'target-url-invalid': 'error',
})

export const SEVERITY_VALUES = Object.freeze(['error', 'warning', 'info'])

/**
 * Rules whose severity is the only thing standing between the run and a pass.
 *
 * Every other error rule also sets the `incomplete` flag, so it exits 2 whatever
 * its severity says; these seven do not, and a demotion to `warning` would take
 * them straight to exit 0. They are the set `test/severity-exit.test.mjs` must
 * drive through the binary one at a time.
 */
export const SEVERITY_DECIDES = Object.freeze([
  'delivery-exhausted-retries',
  'delivery-rejected-permanently',
  'duplicate-event-id-redelivered',
  'event-file-outside-root',
  'event-header-credential',
  'target-host-not-allowed',
  'target-not-declared-receiver',
  'target-url-invalid',
])

const MESSAGE_LIMIT = 400
const PATH_LIMIT = 200

/**
 * Build one finding, taking its severity from the single table.
 *
 * Every untrusted string is sanitised here -- the file label and the pointer as
 * much as the message and the evidence. An event id carrying a newline would
 * otherwise forge whole lines in the human report, and a report a reader cannot
 * trust line by line is worse than no report at all.
 */
export function createFinding(row) {
  const severity = RULE_SEVERITY[row.ruleId]
  if (severity === undefined) {
    throw new Error(
      `Rule "${sanitize(row.ruleId, 80)}" is not in RULE_SEVERITY; add it to the table and to docs/replay-rules.md.`,
    )
  }
  const finding = {
    ruleId: row.ruleId,
    severity,
    message: sanitize(row.message, MESSAGE_LIMIT),
    location: { file: sanitize(row.file, PATH_LIMIT), pointer: sanitize(row.pointer, PATH_LIMIT) },
  }
  if (row.evidence !== undefined && row.evidence !== '') finding.evidence = sanitize(row.evidence, TEXT_LIMIT)
  if (row.suggestion !== undefined) finding.suggestion = sanitize(row.suggestion, MESSAGE_LIMIT)
  return finding
}

/**
 * The documented sort key: file, pointer, ruleId, message, evidence.
 *
 * Every comparison is by code unit. The pointer is compared as the string it
 * is, so `/events/10` precedes `/events/2` -- unlovely, and deterministic,
 * which is the property that matters. Replay order is captured separately and
 * exactly, in `replay.deliveries`.
 */
export function compareFindings(left, right) {
  return (
    byCodeUnit(left.location.file, right.location.file) ||
    byCodeUnit(left.location.pointer, right.location.pointer) ||
    byCodeUnit(left.ruleId, right.ruleId) ||
    byCodeUnit(left.message, right.message) ||
    byCodeUnit(left.evidence ?? '', right.evidence ?? '')
  )
}

/** Findings in the documented order. The input array is not mutated. */
export function sortFindings(findings) {
  return [...findings].sort(compareFindings)
}
