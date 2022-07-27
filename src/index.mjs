/**
 * webhook-replay-harness
 *
 * Replays sanitized webhook event fixtures into a mock receiver that lives in
 * this process, under a virtual clock, and reports what happened.
 *
 * Three properties are structural rather than incidental:
 *
 * 1. **A delivery never leaves this machine.** The receiver is a function call,
 *    not a socket. This package imports no socket, HTTP, datagram, resolver or
 *    TLS module from the platform, invokes no fetch primitive, and spawns no
 *    process, so there is no code path a fixture could steer towards a network.
 *    `test/no-network.test.mjs` proves it the direct way: it opens a real
 *    listener on a real loopback port, declares that port as the receiver, and
 *    asserts the listener saw no connection. A fixture naming an external URL,
 *    a non-loopback host, or any endpoint other than the declared receiver is
 *    refused *before* any attempt is constructed, and that refusal is an error
 *    that fails the run.
 * 2. **Time is virtual.** Retries and backoff advance an injected clock. No
 *    timer is ever set and no run ever sleeps, so a fixture with an hour of
 *    backoff replays instantly and the timestamps in the report are a function
 *    of the fixture alone.
 * 3. **Unknown is never a pass.** A fixture that could not be read, decoded or
 *    parsed, a limit that stopped the replay short, and a run that replayed
 *    nothing at all each make the report `incomplete`. A `pass` with
 *    `checked: 0` is not reachable.
 */

import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

import { backoffDelayMs, createVirtualClock } from './clock.mjs'
import {
  CREDENTIAL_HEADERS,
  DEFAULT_LIMITS,
  MAX_CLOCK_START,
  applyLimits,
  classifyUrl,
  isRecord,
  validatePlan,
} from './plan.mjs'
import { createInProcessReceiver, isRetryableStatus, isSuccessStatus } from './receiver.mjs'
import { compareFindings, createFinding, sortFindings } from './rules.mjs'
import {
  byCodeUnit,
  decodeUtf8,
  exceedsDepth,
  jsonByteLength,
  parseFailureDetail,
  sanitize,
} from './text.mjs'

export const TOOL_ID = 'webhook-replay-harness'
export const REPORT_SCHEMA_VERSION = '1'

/** The plan file itself is bounded, and the bound is reported by name. */
export const MAX_PLAN_BYTES = 1048576

const REPLAY_OPTION_KEYS = Object.freeze(['baseDir', 'clock', 'label', 'limits', 'startMs'])
const FILE_OPTION_KEYS = Object.freeze(['label', 'limits', 'startMs'])

/**
 * Containment, decided on real paths.
 *
 * Refusing `../` is not confinement: a symbolic link planted inside the events
 * root resolves out of the tree without ever spelling a traversal. Both sides
 * of this comparison have been through `realpath` before they arrive --
 * comparing a real root against an unresolved candidate is the over-correction,
 * and it refuses fixtures that genuinely are inside a root reached through a
 * symlink. A false refusal is a bug too.
 */
export function isInside(root, candidate) {
  if (candidate === root) return true
  return candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

function createCollector(label) {
  return { label, rows: [], incomplete: false }
}

function record(collector, row) {
  collector.rows.push({ file: collector.label, ...row })
}

function emptyCounts() {
  return {
    events: 0,
    checked: 0,
    delivered: 0,
    deduplicated: 0,
    refused: 0,
    failed: 0,
    skipped: 0,
    attempts: 0,
    retries: 0,
  }
}

function buildReport(collector, counts, replay, limits) {
  let findings = sortFindings(collector.rows.map(createFinding))
  let truncated = false

  if (findings.length > limits.maxFindings) {
    const dropped = findings.length - limits.maxFindings + 1
    findings = findings.slice(0, limits.maxFindings - 1)
    findings.push(
      createFinding({
        file: collector.label,
        pointer: '/',
        ruleId: 'limit-findings-exceeded',
        message: `The replay produced more findings than the maxFindings limit of ${limits.maxFindings}; ${dropped} of them are not in this report.`,
        suggestion: 'Raise limits.maxFindings or replay fewer events, then re-run; this report is partial.',
      }),
    )
    findings.sort(compareFindings)
    truncated = true
  }

  let errors = 0
  let warnings = 0
  for (const finding of findings) {
    if (finding.severity === 'error') errors += 1
    else if (finding.severity === 'warning') warnings += 1
  }

  const incomplete = collector.incomplete || truncated
  const status = incomplete ? 'incomplete' : errors > 0 ? 'fail' : 'pass'

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked: counts.checked,
      errors,
      warnings,
      info: findings.length - errors - warnings,
      events: counts.events,
      delivered: counts.delivered,
      deduplicated: counts.deduplicated,
      refused: counts.refused,
      failed: counts.failed,
      skipped: counts.skipped,
      attempts: counts.attempts,
      retries: counts.retries,
      virtualElapsedMs: replay.clock.endMs - replay.clock.startMs,
    },
    findings,
    replay,
  }
}

/** The capture shape used when the plan never became replayable. */
function emptyReplay(startMs) {
  return {
    receiver: null,
    ordering: null,
    clock: { startMs, endMs: startMs },
    deliveries: [],
    receiverLog: [],
  }
}

async function resolveEventsRoot(collector, baseDir, eventsRoot) {
  if (eventsRoot === null) return null
  if (typeof baseDir !== 'string' || baseDir === '') {
    throw new TypeError('A plan that declares "eventsRoot" must be replayed with a baseDir to resolve it against')
  }
  try {
    return await realpath(resolve(baseDir, eventsRoot))
  } catch (error) {
    record(collector, {
      pointer: '/eventsRoot',
      ruleId: 'event-file-unreadable',
      message: `The events root could not be resolved: ${error.code ?? 'unknown error'}. No event that names a file was replayed.`,
      evidence: sanitize(eventsRoot, 120),
      suggestion: 'Check "eventsRoot" against the directory layout next to the plan file.',
    })
    collector.incomplete = true
    return null
  }
}

/**
 * Read one event's body from its fixture file.
 *
 * Returns `{ ok: true, payload }`, or an outcome saying why not. A file that
 * resolved outside the root is a *refusal* -- a verdict this harness reached,
 * which fails the run. A file that could not be read, decoded or parsed is
 * evidence nobody obtained, which makes the run incomplete instead.
 */
async function loadEventFile(collector, event, rootReal, limits) {
  if (rootReal === null) return { ok: false, outcome: 'skipped' }

  const absolute = resolve(rootReal, event.file)
  let real
  try {
    real = await realpath(absolute)
  } catch (error) {
    record(collector, {
      pointer: `${event.pointer}/file`,
      ruleId: 'event-file-unreadable',
      message: `Fixture file could not be read: ${error.code ?? 'unknown error'}. Event "${sanitize(event.id, 80)}" was not replayed.`,
      evidence: sanitize(event.fileLabel, 120),
    })
    collector.incomplete = true
    return { ok: false, outcome: 'skipped' }
  }

  if (!isInside(rootReal, real)) {
    record(collector, {
      pointer: `${event.pointer}/file`,
      ruleId: 'event-file-outside-root',
      message: `Fixture file resolves outside the declared events root, so event "${sanitize(event.id, 80)}" was refused unread. Its contents are not in this report.`,
      evidence: sanitize(event.fileLabel, 120),
      suggestion: 'Move the fixture inside the events root, or point "eventsRoot" at the directory that really holds it.',
    })
    return { ok: false, outcome: 'refused' }
  }

  /**
   * Size first, then the bytes, under one failure handler.
   *
   * The size is read from the filesystem rather than from the parsed body on
   * purpose: a body whose serialized form is small can still be an enormous
   * file, and reading that file in to discover it was small is the failure this
   * limit exists to prevent. Both calls fail the same way and are reported the
   * same way, so they share a handler rather than each carrying a copy of it --
   * a second copy that no fixture can reach is a branch nothing pins.
   */
  let bytes
  try {
    const info = await stat(real)
    if (info.size > limits.maxPayloadBytes) {
      record(collector, {
        pointer: `${event.pointer}/file`,
        ruleId: 'limit-payload-bytes-exceeded',
        message: `Fixture file is ${info.size} bytes, above the maxPayloadBytes limit of ${limits.maxPayloadBytes}; event "${sanitize(event.id, 80)}" was not replayed and was not truncated.`,
        evidence: sanitize(event.fileLabel, 120),
        suggestion: 'Raise limits.maxPayloadBytes, or shrink the fixture.',
      })
      collector.incomplete = true
      return { ok: false, outcome: 'skipped' }
    }
    bytes = await readFile(real)
  } catch (error) {
    record(collector, {
      pointer: `${event.pointer}/file`,
      ruleId: 'event-file-unreadable',
      message: `Fixture file could not be read: ${error.code ?? 'unknown error'}. Event "${sanitize(event.id, 80)}" was not replayed.`,
      evidence: sanitize(event.fileLabel, 120),
    })
    collector.incomplete = true
    return { ok: false, outcome: 'skipped' }
  }

  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    record(collector, {
      pointer: `${event.pointer}/file`,
      ruleId: 'event-file-not-utf8',
      message: `Fixture file is not valid UTF-8; event "${sanitize(event.id, 80)}" was not replayed.`,
      evidence: sanitize(event.fileLabel, 120),
      suggestion: 'Re-encode the fixture as UTF-8.',
    })
    collector.incomplete = true
    return { ok: false, outcome: 'skipped' }
  }

  try {
    return { ok: true, payload: JSON.parse(decoded.text) }
  } catch (error) {
    record(collector, {
      pointer: `${event.pointer}/file`,
      ruleId: 'event-file-not-json',
      message: `Fixture file is not valid JSON: ${sanitize(parseFailureDetail(error), 120)}. Event "${sanitize(event.id, 80)}" was not replayed.`,
      evidence: sanitize(event.fileLabel, 120),
    })
    collector.incomplete = true
    return { ok: false, outcome: 'skipped' }
  }
}

/**
 * Decide whether a fixture's target may be delivered.
 *
 * Ordered so that the most alarming answer is the one reported: an external
 * host is named as an external host, not as "not the declared receiver", even
 * though both are true of it.
 */
function classifyTarget(collector, event, plan) {
  const raw = event.target ?? plan.receiver.url
  const classified = classifyUrl(raw, plan.allowedHosts)

  if (!classified.ok) {
    const ruleId = classified.reason === 'host' ? 'target-host-not-allowed' : 'target-url-invalid'
    record(collector, {
      pointer: `${event.pointer}/target`,
      ruleId,
      message: `Delivery refused before any attempt: ${classified.detail}. Event "${sanitize(event.id, 80)}" was not sent anywhere, and nothing left this machine.`,
      evidence: sanitize(raw, 120),
      suggestion: `Point the event at the declared receiver (${sanitize(plan.receiver.url, 80)}), or remove it from the fixture set.`,
    })
    return false
  }

  if (classified.key !== plan.receiver.key) {
    record(collector, {
      pointer: `${event.pointer}/target`,
      ruleId: 'target-not-declared-receiver',
      message: `Delivery refused before any attempt: the target is loopback but is not the declared receiver, so event "${sanitize(event.id, 80)}" was not sent anywhere.`,
      evidence: firstUrlKeyDifference(classified.key, plan.receiver.key),
      suggestion: 'Declare this endpoint as the receiver, or correct the event target.',
    })
    return false
  }
  return true
}

/** Name a mismatch that remains visible even when both URL excerpts share a long prefix. */
function firstUrlKeyDifference(target, receiver) {
  let offset = 0
  while (offset < target.length && offset < receiver.length && target[offset] === receiver[offset]) offset += 1
  const unit = (value) => offset === value.length
    ? 'end of URL'
    : `U+${value.charCodeAt(offset).toString(16).toUpperCase().padStart(4, '0')}`
  return `URL keys first differ at UTF-16 offset ${offset}: target ${unit(target)}; receiver ${unit(receiver)}`
}

function classifyHeaders(collector, event) {
  if (event.headers === null) return true
  const offending = Object.keys(event.headers)
    .map((name) => name.toLowerCase())
    .filter((name) => CREDENTIAL_HEADERS.includes(name))
    .sort(byCodeUnit)
  if (offending.length === 0) return true

  record(collector, {
    pointer: `${event.pointer}/headers`,
    ruleId: 'event-header-credential',
    message: `Fixture carries credential-bearing header(s), so event "${sanitize(event.id, 80)}" was refused unreplayed. A fixture is meant to be sanitized before it is stored, and this tool cannot tell a live token from a placeholder.`,
    evidence: `header name(s): ${offending.map((name) => sanitize(name, 40)).join(', ')}`,
    suggestion: 'Remove the header from the fixture; script the receiver status you need instead of replaying a signature.',
  })
  return false
}

function checkPayloadBounds(collector, event, payload, limits) {
  if (payload === undefined) return true
  const bytes = jsonByteLength(payload)
  if (bytes !== null && bytes > limits.maxPayloadBytes) {
    record(collector, {
      pointer: `${event.pointer}/payload`,
      ruleId: 'limit-payload-bytes-exceeded',
      message: `Payload is ${bytes} bytes, above the maxPayloadBytes limit of ${limits.maxPayloadBytes}; event "${sanitize(event.id, 80)}" was not replayed and was not truncated.`,
      suggestion: 'Raise limits.maxPayloadBytes, or shrink the fixture.',
    })
    collector.incomplete = true
    return false
  }
  if (exceedsDepth(payload, limits.maxPayloadDepth)) {
    record(collector, {
      pointer: `${event.pointer}/payload`,
      ruleId: 'limit-payload-depth-exceeded',
      message: `Payload nests deeper than the maxPayloadDepth limit of ${limits.maxPayloadDepth}; event "${sanitize(event.id, 80)}" was not replayed.`,
      suggestion: 'Raise limits.maxPayloadDepth, or flatten the fixture.',
    })
    collector.incomplete = true
    return false
  }
  return true
}

/**
 * Replay a plan object.
 *
 * `options.clock` injects the clock outright; `options.startMs` sets the start
 * of the one this function would otherwise build. Passing both is a
 * configuration error rather than a precedence rule nobody would remember.
 */
export async function replayPlan(rawPlan, options = {}) {
  if (!isRecord(options)) throw new TypeError('Options must be an object')
  for (const key of Object.keys(options)) {
    if (!REPLAY_OPTION_KEYS.includes(key)) throw new TypeError(`Unknown option "${key}"`)
  }
  if (options.clock !== undefined && options.startMs !== undefined) {
    throw new TypeError('Pass either a clock or a startMs, not both')
  }
  if (options.clock !== undefined) {
    // An injected clock is the one piece of machinery a caller can replace, so
    // its shape is checked here rather than discovered halfway through a replay.
    const { clock } = options
    const shaped = isRecord(clock)
      && Number.isInteger(clock.startMs)
      && typeof clock.now === 'function'
      && typeof clock.advance === 'function'
      && typeof clock.elapsedMs === 'function'
    if (!shaped) throw new TypeError('An injected clock must expose an integer startMs and now(), advance() and elapsedMs() functions')
  }
  if (options.label !== undefined && (typeof options.label !== 'string' || options.label.trim() === '')) {
    throw new TypeError('Label must be a non-empty string')
  }
  // The same bound the plan's own clock.startMs is held to: a caller that can
  // spell past a limit the plan file cannot is not a limit.
  if (options.startMs !== undefined && (!Number.isInteger(options.startMs) || options.startMs < 0 || options.startMs > MAX_CLOCK_START)) {
    throw new TypeError(`startMs must be an integer between 0 and ${MAX_CLOCK_START}`)
  }
  if (options.limits !== undefined) {
    const checked = applyLimits(DEFAULT_LIMITS, options.limits)
    if (checked.errors.length > 0) throw new TypeError(`Invalid limits: ${checked.errors[0]}`)
  }

  const label = options.label ?? 'plan.json'
  const collector = createCollector(label)
  const validated = validatePlan(rawPlan, { label, limitOverrides: options.limits })
  const limits = validated.limits

  if (!validated.ok) {
    collector.rows.push(...validated.rows)
    collector.incomplete = true
    const startMs = options.clock === undefined ? options.startMs ?? 0 : options.clock.startMs
    const counts = emptyCounts()
    record(collector, {
      pointer: '/events',
      ruleId: 'no-events-replayed',
      message: 'No event was replayed, so this run checked nothing. A report with no evidence in it is not a passing report.',
      suggestion: 'Fix the plan errors above, then re-run.',
    })
    return buildReport(collector, counts, emptyReplay(startMs), limits)
  }

  const plan = validated.plan
  const clock = options.clock ?? createVirtualClock(options.startMs ?? plan.startMs)
  const receiver = createInProcessReceiver(plan.receiver)
  const counts = emptyCounts()
  counts.events = plan.events.length

  const rootReal = await resolveEventsRoot(collector, options.baseDir ?? null, plan.eventsRoot)

  const ordered = plan.ordering === 'eventId'
    ? [...plan.events].sort((left, right) => byCodeUnit(left.id, right.id) || left.index - right.index)
    : [...plan.events]

  let replayable = ordered
  if (ordered.length > limits.maxEvents) {
    replayable = ordered.slice(0, limits.maxEvents)
    const dropped = ordered.slice(limits.maxEvents)
    record(collector, {
      pointer: '/events',
      ruleId: 'limit-events-exceeded',
      message: `The plan declares ${ordered.length} events, above the maxEvents limit of ${limits.maxEvents}; ${dropped.length} of them were not replayed.`,
      evidence: `first event not replayed: ${sanitize(dropped[0].id, 80)}`,
      suggestion: 'Raise limits.maxEvents, or split the fixture set across runs.',
    })
    collector.incomplete = true
    counts.skipped += dropped.length
  }

  const deliveries = []
  const seenIds = new Set()
  let stopped = false
  let order = 0

  for (const event of replayable) {
    order += 1
    const delivery = {
      order,
      eventId: sanitize(event.id, 200),
      type: event.type === null ? null : sanitize(event.type, 200),
      source: event.fileLabel === null ? 'inline' : sanitize(event.fileLabel, 200),
      outcome: 'skipped',
      attempts: 0,
      finalStatus: null,
      deduplicated: false,
      firstAttemptAtMs: null,
      lastAttemptAtMs: null,
    }
    deliveries.push(delivery)

    if (stopped) {
      counts.skipped += 1
      continue
    }

    if (clock.elapsedMs() > limits.maxVirtualMs) {
      record(collector, {
        pointer: event.pointer,
        ruleId: 'limit-virtual-time-exceeded',
        message: `Virtual time reached ${clock.elapsedMs()}ms, above the maxVirtualMs limit of ${limits.maxVirtualMs}; the replay stopped and later events were not replayed.`,
        suggestion: 'Raise limits.maxVirtualMs, or shorten the backoff the plan declares.',
      })
      collector.incomplete = true
      stopped = true
      counts.skipped += 1
      continue
    }

    // Policy first, and before anything is read. A fixture pointed at an
    // external host never has its body opened, let alone sent.
    if (!classifyTarget(collector, event, plan) || !classifyHeaders(collector, event)) {
      delivery.outcome = 'refused'
      counts.refused += 1
      counts.checked += 1
      continue
    }

    let payload
    if (event.file !== null) {
      const loaded = await loadEventFile(collector, event, rootReal, limits)
      if (!loaded.ok) {
        delivery.outcome = loaded.outcome
        if (loaded.outcome === 'refused') {
          counts.refused += 1
          counts.checked += 1
        } else counts.skipped += 1
        continue
      }
      payload = loaded.payload
    } else payload = event.payload

    if (!checkPayloadBounds(collector, event, payload, limits)) {
      counts.skipped += 1
      continue
    }

    const repeat = seenIds.has(event.id)
    seenIds.add(event.id)

    let attempt = 0
    let outcome = null
    let finalStatus = null

    while (attempt < plan.delivery.maxAttempts) {
      if (counts.attempts >= limits.maxTotalAttempts) {
        record(collector, {
          pointer: event.pointer,
          ruleId: 'limit-total-attempts-exceeded',
          message: `The replay reached the maxTotalAttempts limit of ${limits.maxTotalAttempts}; it stopped at event "${sanitize(event.id, 80)}" and later events were not replayed.`,
          suggestion: 'Raise limits.maxTotalAttempts, lower delivery.maxAttempts, or replay fewer events.',
        })
        collector.incomplete = true
        stopped = true
        outcome = 'stopped'
        break
      }

      attempt += 1
      counts.attempts += 1
      if (attempt > 1) counts.retries += 1

      const startedAtMs = clock.now()
      if (delivery.firstAttemptAtMs === null) delivery.firstAttemptAtMs = startedAtMs
      const result = receiver.deliver({ eventId: event.id, attempt, atMs: startedAtMs })
      if (result.latencyMs > 0) clock.advance(result.latencyMs)
      delivery.lastAttemptAtMs = clock.now()
      delivery.attempts = attempt
      finalStatus = result.status

      if (result.deduplicated) {
        delivery.deduplicated = true
        outcome = 'deduplicated'
        break
      }
      if (isSuccessStatus(result.status)) {
        receiver.commit(event.id)
        outcome = 'delivered'
        break
      }
      if (!isRetryableStatus(result.status)) {
        outcome = 'rejected'
        break
      }
      if (attempt >= plan.delivery.maxAttempts) {
        outcome = 'exhausted'
        break
      }

      const delay = backoffDelayMs(attempt, plan.delivery)
      if (clock.elapsedMs() + delay > limits.maxVirtualMs) {
        record(collector, {
          pointer: event.pointer,
          ruleId: 'limit-virtual-time-exceeded',
          message: `Waiting ${delay}ms before attempt ${attempt + 1} would pass the maxVirtualMs limit of ${limits.maxVirtualMs}; event "${sanitize(event.id, 80)}" has no recorded outcome and the replay stopped.`,
          suggestion: 'Raise limits.maxVirtualMs, or shorten the backoff the plan declares.',
        })
        collector.incomplete = true
        stopped = true
        outcome = 'stopped'
        break
      }
      clock.advance(delay)
    }

    delivery.outcome = outcome ?? 'stopped'
    delivery.finalStatus = finalStatus

    if (outcome === 'stopped' || outcome === null) {
      counts.skipped += 1
      continue
    }

    counts.checked += 1

    /**
     * A repeat id that the receiver actually processed again, whatever it then
     * answered. The hazard is the second processing, not the status it
     * returned, so this is reported for a rejected or exhausted redelivery too
     * -- a receiver that reprocesses a duplicate and then fails it has still
     * reprocessed it.
     */
    if (repeat && outcome !== 'deduplicated') {
      record(collector, {
        pointer: event.pointer,
        ruleId: 'duplicate-event-id-redelivered',
        message: `Event id "${sanitize(event.id, 80)}" reached the receiver a second time and was not deduplicated, so the same event was processed twice.`,
        evidence: `outcome ${outcome}, final status ${finalStatus}, receiver dedupe ${plan.receiver.dedupe ? 'on' : 'off'}`,
        suggestion: 'Turn on receiver dedupe, or give the redelivery its own id if it really is a different event.',
      })
    }

    if (outcome === 'delivered') {
      counts.delivered += 1
      if (attempt > 1) {
        record(collector, {
          pointer: event.pointer,
          ruleId: 'delivery-retried',
          message: `Event "${sanitize(event.id, 80)}" was accepted on attempt ${attempt} of ${plan.delivery.maxAttempts}, after ${attempt - 1} retry(s) under virtual time.`,
          evidence: `final status ${finalStatus} at ${delivery.lastAttemptAtMs}ms`,
        })
      }
    } else if (outcome === 'deduplicated') {
      counts.deduplicated += 1
      record(collector, {
        pointer: event.pointer,
        ruleId: 'duplicate-event-id-deduplicated',
        message: `Event id "${sanitize(event.id, 80)}" arrived again and the receiver deduplicated it, answering ${finalStatus} without processing it a second time.`,
        evidence: `attempt 1, answered ${finalStatus}`,
      })
    } else if (outcome === 'rejected') {
      counts.failed += 1
      record(collector, {
        pointer: event.pointer,
        ruleId: 'delivery-rejected-permanently',
        message: `The receiver answered ${finalStatus} for event "${sanitize(event.id, 80)}", which is not retryable, so no retry was attempted.`,
        evidence: `status ${finalStatus} on attempt ${attempt}`,
        suggestion: 'Fix the fixture or the receiver script; a non-retryable status will never become a delivery.',
      })
    } else if (outcome === 'exhausted') {
      counts.failed += 1
      record(collector, {
        pointer: event.pointer,
        ruleId: 'delivery-exhausted-retries',
        message: `Event "${sanitize(event.id, 80)}" was never accepted: ${attempt} attempt(s) all failed, the last with status ${finalStatus}, and the retry budget is exhausted.`,
        evidence: `virtual time spent ${delivery.lastAttemptAtMs - delivery.firstAttemptAtMs}ms`,
        suggestion: 'Raise delivery.maxAttempts, or correct the receiver script this fixture exercises.',
      })
    }
  }

  /**
   * Green on no evidence is a defect, not a clean bill of health. The test is
   * `checked` -- the field the guarantee is written in terms of -- so a run
   * that declared fifty events and reached a verdict on none of them is
   * reported here rather than passing quietly.
   */
  if (counts.checked === 0) {
    record(collector, {
      pointer: '/events',
      ruleId: 'no-events-replayed',
      message: `No event was replayed to a verdict, so this run checked nothing. ${counts.events} event(s) were declared and ${counts.skipped} were not replayed.`,
      suggestion: 'Check the plan targets and limits; an empty replay proves nothing about the receiver.',
    })
    collector.incomplete = true
  }

  const replay = {
    receiver: {
      id: sanitize(plan.receiver.id, 120),
      url: sanitize(plan.receiver.key, 200),
      urlKeySha256: createHash('sha256').update(plan.receiver.key, 'utf8').digest('hex'),
      transport: plan.receiver.transport,
      dedupe: plan.receiver.dedupe,
    },
    ordering: plan.ordering,
    clock: { startMs: clock.startMs, endMs: clock.now() },
    deliveries,
    receiverLog: receiver.entries().map((entry) => ({
      sequence: entry.sequence,
      eventId: sanitize(entry.eventId, 200),
      attempt: entry.attempt,
      atMs: entry.atMs,
      status: entry.status,
      deduplicated: entry.deduplicated,
    })),
  }

  return buildReport(collector, counts, replay, limits)
}

/** A report that carries the reason an input could not be evaluated. */
function unreadableReport(label, ruleId, message, suggestion) {
  const collector = createCollector(label)
  collector.incomplete = true
  record(collector, { pointer: '/', ruleId, message, ...(suggestion === undefined ? {} : { suggestion }) })
  record(collector, {
    pointer: '/events',
    ruleId: 'no-events-replayed',
    message: 'No event was replayed, so this run checked nothing. A report with no evidence in it is not a passing report.',
  })
  return buildReport(collector, emptyCounts(), emptyReplay(0), DEFAULT_LIMITS)
}

/**
 * Read a plan file and replay it.
 *
 * The plan file is decoded with the same strict decoder as every fixture: a
 * tool that hardens its data path and leaves its own configuration path lossy
 * has hardened nothing.
 */
export async function replayPlanFile(planPath, options = {}) {
  if (typeof planPath !== 'string' || planPath.trim() === '') throw new TypeError('A plan path is required')
  if (!isRecord(options)) throw new TypeError('Options must be an object')
  for (const key of Object.keys(options)) {
    if (!FILE_OPTION_KEYS.includes(key)) throw new TypeError(`Unknown option "${key}"`)
  }
  const label = options.label ?? planPath

  const absolute = resolve(planPath)
  let info
  try {
    info = await stat(absolute)
  } catch (error) {
    return unreadableReport(label, 'plan-unreadable', `The plan file could not be read: ${error.code ?? 'unknown error'}.`, 'Check the --plan path and its permissions.')
  }
  if (!info.isFile()) {
    return unreadableReport(label, 'plan-unreadable', 'The plan path is not a regular file.', 'Pass the JSON plan file to --plan.')
  }
  if (info.size > MAX_PLAN_BYTES) {
    return unreadableReport(
      label,
      'limit-plan-bytes-exceeded',
      `The plan file is ${info.size} bytes, above the limit of ${MAX_PLAN_BYTES}; it was not parsed and nothing was replayed.`,
      'Split the fixture set, or move large payloads into files under "eventsRoot".',
    )
  }

  let bytes
  try {
    bytes = await readFile(absolute)
  } catch (error) {
    return unreadableReport(label, 'plan-unreadable', `The plan file could not be read: ${error.code ?? 'unknown error'}.`, 'Check the --plan path and its permissions.')
  }

  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    return unreadableReport(label, 'plan-not-utf8', 'The plan file is not valid UTF-8; it was not parsed and nothing was replayed.', 'Re-encode the plan as UTF-8.')
  }

  let parsed
  try {
    parsed = JSON.parse(decoded.text)
  } catch (error) {
    return unreadableReport(label, 'plan-not-json', `The plan file is not valid JSON: ${sanitize(parseFailureDetail(error), 160)}.`, 'Validate the plan with a JSON parser before re-running.')
  }

  let baseDir
  try {
    baseDir = await realpath(dirname(absolute))
  } catch {
    baseDir = dirname(absolute)
  }

  return replayPlan(parsed, {
    label,
    baseDir,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.startMs === undefined ? {} : { startMs: options.startMs }),
  })
}

export function exitCodeFor(report) {
  if (report.status === 'incomplete') return 2
  return report.status === 'fail' ? 1 : 0
}

/** The JSON report, exactly as it goes to stdout. */
export function serializeReport(report) {
  return JSON.stringify(report, null, 2)
}

const SEVERITY_WIDTH = 7

/**
 * The human summary. Every untrusted string in it was sanitised on the way into
 * the finding, so a fixture cannot forge a line here.
 */
export function formatReport(report) {
  const { summary, replay } = report
  const receiver = replay.receiver === null ? 'none (the plan was not replayable)' : `${replay.receiver.id} at ${replay.receiver.url} (${replay.receiver.transport})`
  const lines = [
    `${summary.checked} of ${summary.events} event(s) replayed to a verdict: ${summary.errors} error, ${summary.warnings} warning, ${summary.info} info, status ${report.status}.`,
    `receiver: ${receiver}. No socket was opened and nothing left this machine.`,
    `outcomes: ${summary.delivered} delivered, ${summary.deduplicated} deduplicated, ${summary.refused} refused, ${summary.failed} failed, ${summary.skipped} not replayed.`,
    `attempts: ${summary.attempts} total, ${summary.retries} of them retries, across ${summary.virtualElapsedMs}ms of virtual time.`,
  ]
  for (const finding of report.findings) {
    const quoted = finding.evidence === undefined ? '' : ` -- ${finding.evidence}`
    lines.push(
      `${finding.severity.toUpperCase().padEnd(SEVERITY_WIDTH)} ${finding.location.file}${finding.location.pointer} ${finding.ruleId} ${finding.message}${quoted}`,
    )
  }
  return `${lines.join('\n')}\n`
}

export { createVirtualClock, backoffDelayMs } from './clock.mjs'
export { RULE_SEVERITY, SEVERITY_DECIDES, SEVERITY_VALUES, compareFindings, createFinding, sortFindings } from './rules.mjs'
export {
  CREDENTIAL_HEADERS,
  DEFAULT_ALLOWED_HOSTS,
  DEFAULT_DELIVERY,
  DEFAULT_LIMITS,
  HARD_LIMITS,
  MAX_CLOCK_START,
  ORDERINGS,
  applyLimits,
  classifyUrl,
  isLoopbackHost,
  normalizeHost,
  validatePlan,
} from './plan.mjs'
export { SUPPORTED_TRANSPORTS, createInProcessReceiver, isRetryableStatus, isSuccessStatus } from './receiver.mjs'
export {
  byCodeUnit,
  decodeUtf8,
  exceedsDepth,
  jsonByteLength,
  parseFailureDetail,
  sanitize,
} from './text.mjs'
