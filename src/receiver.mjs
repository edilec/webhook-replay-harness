/**
 * webhook-replay-harness -- the mock receiver.
 *
 * The receiver is a plain object in this process. It opens no socket, binds no
 * port and resolves no hostname: a "delivery" is a function call, and the URL a
 * fixture names is checked against the declared receiver rather than dialled.
 * That is the whole safety property of this tool, and it is structural rather
 * than a policy this module could be talked out of -- there is nothing here
 * that could reach a network even if a fixture asked it to.
 *
 * What the receiver does with a delivery is scripted by the plan: a status per
 * attempt, so a fixture can exercise a retry, a permanent rejection, or a
 * success on the third try, with no flakiness and no waiting.
 */

import { byCodeUnit } from './text.mjs'

/**
 * The only transport this tool implements.
 *
 * A loopback socket is deliberately absent rather than unfinished. An
 * in-process receiver cannot leak a delivery to a machine that is listening on
 * the port a fixture happens to name, and it cannot be made to by editing a
 * fixture. See "Limits and non-goals" in the README.
 */
export const SUPPORTED_TRANSPORTS = Object.freeze(['in-process'])

/** Statuses that mean the receiver accepted the event. */
export function isSuccessStatus(status) {
  return status >= 200 && status <= 299
}

/**
 * Statuses a sender is expected to retry.
 *
 * The list is closed and documented rather than "anything that is not a
 * success": treating a 403 as retryable would burn the whole retry budget on a
 * delivery that was never going to be accepted, and reporting it as an
 * exhausted retry budget would name the wrong cause.
 */
export function isRetryableStatus(status) {
  if (status === 408 || status === 425 || status === 429) return true
  return status >= 500 && status <= 599
}

/**
 * Build the in-process receiver described by a validated plan.
 *
 * `script` is a list of `{ event, statuses, latencyMs }` rules. The status for
 * attempt *n* is `statuses[n - 1]`, and the last entry repeats for every later
 * attempt, so `[503, 200]` means "fail once, then accept for ever" rather than
 * "fail once, accept once, then fall off the end of the array".
 */
export function createInProcessReceiver(declaration) {
  const scripts = new Map()
  for (const rule of declaration.script) {
    scripts.set(rule.event, { statuses: rule.statuses, latencyMs: rule.latencyMs })
  }

  const seen = new Set()
  const log = []
  let handled = 0
  let deduplicated = 0

  return {
    id: declaration.id,
    url: declaration.url,
    transport: declaration.transport,
    dedupe: declaration.dedupe,

    /**
     * Handle one delivery attempt.
     *
     * A duplicate is decided on ids the receiver has already *accepted*, so the
     * second attempt of a retried event is not mistaken for a redelivery of it:
     * an id is committed only once a delivery succeeds.
     */
    deliver({ eventId, attempt, atMs }) {
      if (declaration.dedupe && seen.has(eventId)) {
        deduplicated += 1
        const entry = { sequence: log.length + 1, eventId, attempt, atMs, status: declaration.dedupeStatus, deduplicated: true }
        log.push(entry)
        return { status: declaration.dedupeStatus, deduplicated: true, latencyMs: 0 }
      }

      handled += 1
      const rule = scripts.get(eventId)
      let status = declaration.defaultStatus
      let latencyMs = declaration.latencyMs
      if (rule !== undefined) {
        status = rule.statuses[Math.min(attempt - 1, rule.statuses.length - 1)]
        latencyMs = rule.latencyMs
      }
      const entry = { sequence: log.length + 1, eventId, attempt, atMs, status, deduplicated: false }
      log.push(entry)
      return { status, deduplicated: false, latencyMs }
    },

    /** Record an id as accepted. Only a successful delivery commits. */
    commit(eventId) {
      seen.add(eventId)
    },

    /** Ids the receiver has accepted, in code-unit order. */
    accepted() {
      return [...seen].sort(byCodeUnit)
    },

    /** Every attempt the receiver saw, in the order it saw them. */
    entries() {
      return [...log]
    },

    stats() {
      return { handled, deduplicated, accepted: seen.size }
    },
  }
}
