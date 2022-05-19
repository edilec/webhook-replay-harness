/**
 * webhook-replay-harness -- the replay plan, and the policy that decides where
 * a delivery is allowed to go.
 *
 * Two rules run this module.
 *
 * **Nothing is ignored.** An unknown key, a misspelled limit, a script rule
 * naming an event that is not in the plan -- each one is an error that stops
 * the replay, not a value quietly dropped. A one-character typo in a fixture
 * must never be the reason a real failure came back green.
 *
 * **The allowlist can only narrow.** A target is delivered only if it is a
 * loopback URL *and* its host is in the declared allowlist *and* it is the
 * declared receiver. Adding `hooks.example.com` to `allowedHosts` does not make
 * it deliverable; the loopback test is applied first and there is no way to
 * spell past it.
 */

import { SUPPORTED_TRANSPORTS } from './receiver.mjs'
import { byCodeUnit, joinRelative, sanitize } from './text.mjs'

/** Bounds are part of the contract, not a safety net. Each is reported by name. */
export const DEFAULT_LIMITS = Object.freeze({
  maxEvents: 500,
  maxAttemptsPerEvent: 10,
  maxTotalAttempts: 5000,
  maxPayloadBytes: 65536,
  maxPayloadDepth: 16,
  maxVirtualMs: 3600000,
  maxFindings: 500,
})

/** A plan may lower a limit. It may never raise one past these caps. */
export const HARD_LIMITS = Object.freeze({
  maxEvents: 5000,
  maxAttemptsPerEvent: 50,
  maxTotalAttempts: 50000,
  maxPayloadBytes: 1048576,
  maxPayloadDepth: 64,
  maxVirtualMs: 604800000,
  maxFindings: 5000,
})

export const DEFAULT_DELIVERY = Object.freeze({
  maxAttempts: 3,
  backoffMs: 1000,
  backoffFactor: 2,
  maxBackoffMs: 60000,
})

export const DEFAULT_ALLOWED_HOSTS = Object.freeze(['127.0.0.1', '::1', 'localhost'])
export const ORDERINGS = Object.freeze(['eventId', 'fixture'])
export const DEFAULT_ORDERING = 'fixture'

/**
 * Header names refused outright.
 *
 * A fixture is meant to be sanitized before it is committed anywhere, and this
 * tool is the wrong place to decide that `Bearer REDACTED` is a placeholder
 * rather than a live token. So the refusal is by name and unconditional: strip
 * the header from the fixture, and if the receiver under test needs to see one,
 * script the status it should answer with instead.
 */
export const CREDENTIAL_HEADERS = Object.freeze([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-amz-security-token',
  'x-api-key',
  'x-auth-token',
  'x-hub-signature',
  'x-hub-signature-256',
  'x-signature',
  'x-webhook-secret',
])

const PLAN_KEYS = Object.freeze(['allowedHosts', 'clock', 'delivery', 'events', 'eventsRoot', 'limits', 'ordering', 'receiver'])
const RECEIVER_KEYS = Object.freeze(['dedupe', 'dedupeStatus', 'defaultStatus', 'id', 'latencyMs', 'script', 'transport', 'url'])
const SCRIPT_KEYS = Object.freeze(['event', 'latencyMs', 'statuses'])
const DELIVERY_KEYS = Object.freeze(['backoffFactor', 'backoffMs', 'maxAttempts', 'maxBackoffMs'])
const CLOCK_KEYS = Object.freeze(['startMs'])
const EVENT_KEYS = Object.freeze(['file', 'headers', 'id', 'payload', 'target', 'type'])

const MAX_ALLOWED_HOSTS = 16
const MAX_SCRIPT_RULES = 1000
const MAX_STATUSES = 32
const MAX_HEADERS = 32
const MAX_ID_LENGTH = 200
const MIN_STATUS = 100
const MAX_STATUS = 599
const MAX_BACKOFF_FACTOR = 10

export function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** A host, as a URL parser hands it over: lower-cased, with IPv6 brackets removed. */
export function normalizeHost(host) {
  return String(host).toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
}

/**
 * Whether a host names this machine's loopback interface.
 *
 * Decided on the literal text, never by resolving it: resolution is a network
 * operation, and a tool whose safety property is "no delivery leaves this
 * machine" cannot begin by asking a resolver. `localhost` is accepted as the
 * name it is -- since no socket is ever opened, a hosts file that points it
 * somewhere else cannot turn an in-process function call into a request.
 */
export function isLoopbackHost(host) {
  const value = normalizeHost(host)
  if (value === 'localhost' || value === '::1') return true
  const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
  if (match === null) return false
  return match.slice(1).every((part) => Number(part) <= 255)
}

/**
 * Classify a declared URL against the policy.
 *
 * Returns the comparison key a target is matched on -- origin, path and query,
 * with any fragment dropped, because a fragment is never sent to a server and
 * two fixtures that differ only by one address the same endpoint.
 */
export function classifyUrl(raw, allowedHosts) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, reason: 'invalid', detail: 'not a non-empty string' }
  }
  let url
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'invalid', detail: 'not an absolute URL' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'invalid', detail: `scheme "${url.protocol.replace(/:$/, '')}" is not http or https` }
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'invalid', detail: 'carries embedded credentials in the URL' }
  }
  if (!isLoopbackHost(url.hostname)) {
    return { ok: false, reason: 'host', detail: `host "${normalizeHost(url.hostname)}" is not a loopback address` }
  }
  if (!allowedHosts.includes(normalizeHost(url.hostname))) {
    return { ok: false, reason: 'host', detail: `host "${normalizeHost(url.hostname)}" is not in the declared allowedHosts` }
  }
  return { ok: true, key: `${url.origin}${url.pathname}${url.search}`, host: normalizeHost(url.hostname) }
}

/**
 * Apply one layer of limit overrides.
 *
 * Returns the messages rather than throwing, because the same check serves two
 * callers with two contracts: an override that came from the API or the CLI is
 * a configuration error with an empty stdout, and one that came from the plan
 * file is a finding in an `incomplete` report.
 */
export function applyLimits(base, overrides) {
  const errors = []
  const limits = { ...base }
  if (overrides === undefined) return { limits: Object.freeze(limits), errors }
  if (!isRecord(overrides)) return { limits: Object.freeze(limits), errors: ['limits must be an object'] }

  for (const name of Object.keys(overrides).sort(byCodeUnit)) {
    const value = overrides[name]
    if (!Object.hasOwn(DEFAULT_LIMITS, name)) {
      errors.push(`unknown limit "${sanitize(name, 80)}"; known limits: ${Object.keys(DEFAULT_LIMITS).sort(byCodeUnit).join(', ')}`)
      continue
    }
    if (!Number.isInteger(value) || value < 1) {
      errors.push(`limit "${name}" must be a positive integer`)
      continue
    }
    if (value > HARD_LIMITS[name]) {
      errors.push(`limit "${name}" is ${value}, above the hard cap of ${HARD_LIMITS[name]}`)
      continue
    }
    limits[name] = value
  }
  return { limits: Object.freeze(limits), errors }
}

function createSink(label) {
  const rows = []
  return {
    rows,
    invalid(pointer, message, suggestion) {
      rows.push({ file: label, pointer, ruleId: 'plan-invalid', message, ...(suggestion === undefined ? {} : { suggestion }) })
    },
    unknown(pointer, key, allowed) {
      rows.push({
        file: label,
        pointer: `${pointer}/${sanitize(key, 80)}`,
        ruleId: 'plan-unknown-key',
        message: `Unknown key "${sanitize(key, 80)}"; it was refused rather than ignored, because an ignored key checks nothing at all.`,
        evidence: `known keys: ${allowed.join(', ')}`,
        suggestion: 'Correct the spelling or remove the key, then re-run.',
      })
    },
    refuseReceiver(pointer, message, suggestion) {
      rows.push({ file: label, pointer, ruleId: 'receiver-not-declared-local', message, suggestion })
    },
  }
}

function checkKeys(record, allowed, pointer, sink) {
  let bad = false
  for (const key of Object.keys(record).sort(byCodeUnit)) {
    if (!allowed.includes(key)) {
      sink.unknown(pointer, key, allowed)
      bad = true
    }
  }
  return bad
}

function readInteger(record, key, pointer, sink, { min, max, fallback }) {
  if (!Object.hasOwn(record, key)) return fallback
  const value = record[key]
  if (!Number.isInteger(value) || value < min || value > max) {
    sink.invalid(`${pointer}/${key}`, `"${key}" must be an integer between ${min} and ${max}.`)
    return null
  }
  return value
}

function readBoolean(record, key, pointer, sink, fallback) {
  if (!Object.hasOwn(record, key)) return fallback
  if (typeof record[key] !== 'boolean') {
    sink.invalid(`${pointer}/${key}`, `"${key}" must be true or false.`)
    return null
  }
  return record[key]
}

function readString(record, key, pointer, sink, { maxLength = MAX_ID_LENGTH, required = false, fallback = null }) {
  if (!Object.hasOwn(record, key)) {
    if (required) sink.invalid(`${pointer}/${key}`, `"${key}" is required.`)
    return required ? null : fallback
  }
  const value = record[key]
  if (typeof value !== 'string' || value.trim() === '') {
    sink.invalid(`${pointer}/${key}`, `"${key}" must be a non-empty string.`)
    return null
  }
  if (value.length > maxLength) {
    sink.invalid(`${pointer}/${key}`, `"${key}" is ${value.length} characters; the limit is ${maxLength}.`)
    return null
  }
  return value
}

/** A path a fixture may name: relative, and no parent traversal spelled in it. */
function readRelativePath(record, key, pointer, sink) {
  const value = readString(record, key, pointer, sink, { maxLength: 400 })
  if (value === null || value === undefined) return value
  if (/^(?:[/\\]|[A-Za-z]:)/.test(value)) {
    sink.invalid(`${pointer}/${key}`, `"${key}" must be a path relative to the plan, not an absolute path.`)
    return null
  }
  return value
}

/**
 * Validate a replay plan.
 *
 * Every problem found here stops the replay entirely: a plan that could not be
 * understood is evidence nobody obtained, so the report is `incomplete` and the
 * exit code is 2. Whether a *target* is deliverable is decided later, per
 * event, because a refusal is a verdict the harness reached -- not evidence it
 * failed to get.
 */
export function validatePlan(raw, options) {
  const label = options.label
  const sink = createSink(label)
  const limitLayers = options.limitOverrides ?? {}

  if (!isRecord(raw)) {
    sink.invalid('/', 'The plan must be a JSON object.', 'See docs/replay-rules.md for the plan schema.')
    return { ok: false, rows: sink.rows, limits: DEFAULT_LIMITS }
  }

  checkKeys(raw, PLAN_KEYS, '', sink)

  const planLimits = applyLimits(DEFAULT_LIMITS, raw.limits)
  for (const message of planLimits.errors) {
    const ruleId = message.startsWith('unknown limit') ? 'plan-unknown-key' : 'plan-invalid'
    sink.rows.push({
      file: label,
      pointer: '/limits',
      ruleId,
      message: `Plan limits are invalid: ${message}.`,
      suggestion: 'Correct the limit, or remove it to use the documented default.',
    })
  }
  const cliLimits = applyLimits(planLimits.limits, limitLayers)
  for (const message of cliLimits.errors) {
    sink.invalid('/limits', `Limit override is invalid: ${message}.`)
  }
  const limits = cliLimits.limits

  let ordering = DEFAULT_ORDERING
  if (Object.hasOwn(raw, 'ordering')) {
    if (!ORDERINGS.includes(raw.ordering)) {
      sink.invalid('/ordering', `"ordering" must be one of: ${[...ORDERINGS].sort(byCodeUnit).join(', ')}.`)
      ordering = null
    } else ordering = raw.ordering
  }

  let startMs = 0
  if (Object.hasOwn(raw, 'clock')) {
    if (!isRecord(raw.clock)) sink.invalid('/clock', '"clock" must be an object.')
    else {
      checkKeys(raw.clock, CLOCK_KEYS, '/clock', sink)
      startMs = readInteger(raw.clock, 'startMs', '/clock', sink, { min: 0, max: HARD_LIMITS.maxVirtualMs, fallback: 0 })
    }
  }

  const delivery = { ...DEFAULT_DELIVERY }
  if (Object.hasOwn(raw, 'delivery')) {
    if (!isRecord(raw.delivery)) sink.invalid('/delivery', '"delivery" must be an object.')
    else {
      checkKeys(raw.delivery, DELIVERY_KEYS, '/delivery', sink)
      delivery.maxAttempts = readInteger(raw.delivery, 'maxAttempts', '/delivery', sink, {
        min: 1,
        max: limits.maxAttemptsPerEvent,
        fallback: Math.min(DEFAULT_DELIVERY.maxAttempts, limits.maxAttemptsPerEvent),
      })
      delivery.backoffMs = readInteger(raw.delivery, 'backoffMs', '/delivery', sink, { min: 0, max: limits.maxVirtualMs, fallback: DEFAULT_DELIVERY.backoffMs })
      delivery.backoffFactor = readInteger(raw.delivery, 'backoffFactor', '/delivery', sink, { min: 1, max: MAX_BACKOFF_FACTOR, fallback: DEFAULT_DELIVERY.backoffFactor })
      delivery.maxBackoffMs = readInteger(raw.delivery, 'maxBackoffMs', '/delivery', sink, { min: 0, max: limits.maxVirtualMs, fallback: DEFAULT_DELIVERY.maxBackoffMs })
    }
  }

  let allowedHosts = [...DEFAULT_ALLOWED_HOSTS]
  if (Object.hasOwn(raw, 'allowedHosts')) {
    const value = raw.allowedHosts
    if (!Array.isArray(value) || value.length === 0) {
      sink.invalid('/allowedHosts', '"allowedHosts" must be a non-empty array of host names.')
      allowedHosts = null
    } else if (value.length > MAX_ALLOWED_HOSTS) {
      sink.invalid('/allowedHosts', `"allowedHosts" holds ${value.length} entries; the limit is ${MAX_ALLOWED_HOSTS}.`)
      allowedHosts = null
    } else if (!value.every((host) => typeof host === 'string' && host.trim() !== '')) {
      sink.invalid('/allowedHosts', '"allowedHosts" entries must be non-empty strings.')
      allowedHosts = null
    } else {
      allowedHosts = value.map(normalizeHost)
    }
  }

  const eventsRoot = Object.hasOwn(raw, 'eventsRoot') ? readRelativePath(raw, 'eventsRoot', '', sink) : null

  const receiver = validateReceiver(raw.receiver, allowedHosts ?? [], limits, sink)
  const events = validateEvents(raw.events, { eventsRoot, sink, limits })

  if (receiver !== null && events !== null) {
    const declared = new Set(events.map((event) => event.id))
    for (const rule of receiver.script) {
      if (!declared.has(rule.event)) {
        sink.invalid(
          '/receiver/script',
          `Script rule names event "${sanitize(rule.event, 80)}", which no event in this plan declares, so the statuses it scripts would never be used.`,
          'Correct the event id, or remove the rule.',
        )
      }
    }
  }

  if (sink.rows.length > 0) return { ok: false, rows: sink.rows, limits }

  return {
    ok: true,
    rows: [],
    limits,
    plan: {
      receiver,
      events,
      eventsRoot,
      allowedHosts,
      ordering,
      delivery,
      startMs,
    },
  }
}

function validateReceiver(raw, allowedHosts, limits, sink) {
  if (!isRecord(raw)) {
    sink.invalid('/receiver', '"receiver" is required and must be an object declaring the one local endpoint deliveries may reach.')
    return null
  }
  let bad = checkKeys(raw, RECEIVER_KEYS, '/receiver', sink)

  const id = readString(raw, 'id', '/receiver', sink, { required: true })
  const transport = Object.hasOwn(raw, 'transport') ? raw.transport : SUPPORTED_TRANSPORTS[0]
  if (!SUPPORTED_TRANSPORTS.includes(transport)) {
    sink.invalid(
      '/receiver/transport',
      `"transport" must be one of: ${SUPPORTED_TRANSPORTS.join(', ')}. A loopback socket is not implemented, deliberately: an in-process receiver cannot leak a delivery to whatever is listening on the port a fixture names.`,
    )
    bad = true
  }

  let url = null
  if (!Object.hasOwn(raw, 'url') || typeof raw.url !== 'string' || raw.url.trim() === '') {
    sink.invalid('/receiver/url', '"url" is required and must be a non-empty string.')
    bad = true
  } else {
    const classified = classifyUrl(raw.url, allowedHosts)
    if (!classified.ok) {
      sink.refuseReceiver(
        '/receiver/url',
        `Declared receiver "${sanitize(raw.url, 120)}" was refused: ${classified.detail}. Nothing was replayed and no delivery was attempted.`,
        'Point the receiver at a loopback URL such as http://127.0.0.1:8787/hooks, and list its host in allowedHosts.',
      )
      bad = true
    } else url = { raw: raw.url, key: classified.key }
  }

  const defaultStatus = readInteger(raw, 'defaultStatus', '/receiver', sink, { min: MIN_STATUS, max: MAX_STATUS, fallback: 200 })
  const dedupeStatus = readInteger(raw, 'dedupeStatus', '/receiver', sink, { min: MIN_STATUS, max: MAX_STATUS, fallback: 200 })
  const latencyMs = readInteger(raw, 'latencyMs', '/receiver', sink, { min: 0, max: limits.maxVirtualMs, fallback: 0 })
  const dedupe = readBoolean(raw, 'dedupe', '/receiver', sink, true)

  const script = []
  if (Object.hasOwn(raw, 'script')) {
    if (!Array.isArray(raw.script)) {
      sink.invalid('/receiver/script', '"script" must be an array of rules.')
      bad = true
    } else if (raw.script.length > MAX_SCRIPT_RULES) {
      sink.invalid('/receiver/script', `"script" holds ${raw.script.length} rules; the limit is ${MAX_SCRIPT_RULES}.`)
      bad = true
    } else {
      raw.script.forEach((rule, index) => {
        const pointer = `/receiver/script/${index}`
        if (!isRecord(rule)) {
          sink.invalid(pointer, 'Each script rule must be an object.')
          bad = true
          return
        }
        checkKeys(rule, SCRIPT_KEYS, pointer, sink)
        const event = readString(rule, 'event', pointer, sink, { required: true })
        const ruleLatency = readInteger(rule, 'latencyMs', pointer, sink, { min: 0, max: limits.maxVirtualMs, fallback: latencyMs ?? 0 })
        let statuses = null
        if (!Array.isArray(rule.statuses) || rule.statuses.length === 0) {
          sink.invalid(`${pointer}/statuses`, '"statuses" must be a non-empty array of HTTP status codes.')
        } else if (rule.statuses.length > MAX_STATUSES) {
          sink.invalid(`${pointer}/statuses`, `"statuses" holds ${rule.statuses.length} entries; the limit is ${MAX_STATUSES}.`)
        } else if (!rule.statuses.every((status) => Number.isInteger(status) && status >= MIN_STATUS && status <= MAX_STATUS)) {
          sink.invalid(`${pointer}/statuses`, `"statuses" entries must be integers between ${MIN_STATUS} and ${MAX_STATUS}.`)
        } else statuses = [...rule.statuses]

        if (event !== null && statuses !== null && ruleLatency !== null) {
          script.push({ event, statuses, latencyMs: ruleLatency })
        } else bad = true
      })
    }
  }

  if (bad || id === null || url === null || defaultStatus === null || dedupeStatus === null || latencyMs === null || dedupe === null) {
    return null
  }
  return {
    id,
    transport,
    url: url.raw,
    key: url.key,
    defaultStatus,
    dedupeStatus,
    latencyMs,
    dedupe,
    script,
  }
}

function validateEvents(raw, { eventsRoot, sink, limits }) {
  if (!Array.isArray(raw)) {
    sink.invalid('/events', '"events" is required and must be an array of event fixtures.')
    return null
  }
  let bad = false
  const events = []

  raw.forEach((entry, index) => {
    const pointer = `/events/${index}`
    if (!isRecord(entry)) {
      sink.invalid(pointer, 'Each event must be an object.')
      bad = true
      return
    }
    checkKeys(entry, EVENT_KEYS, pointer, sink)
    const id = readString(entry, 'id', pointer, sink, { required: true })
    const type = Object.hasOwn(entry, 'type') ? readString(entry, 'type', pointer, sink, {}) : null
    let target = null
    if (Object.hasOwn(entry, 'target')) {
      if (typeof entry.target !== 'string' || entry.target.trim() === '') {
        sink.invalid(`${pointer}/target`, '"target" must be a non-empty string.')
        bad = true
      } else target = entry.target
    }

    let headers = null
    if (Object.hasOwn(entry, 'headers')) {
      if (!isRecord(entry.headers)) {
        sink.invalid(`${pointer}/headers`, '"headers" must be an object.')
        bad = true
      } else if (Object.keys(entry.headers).length > MAX_HEADERS) {
        sink.invalid(`${pointer}/headers`, `"headers" holds ${Object.keys(entry.headers).length} entries; the limit is ${MAX_HEADERS}.`)
        bad = true
      } else if (!Object.values(entry.headers).every((value) => typeof value === 'string')) {
        sink.invalid(`${pointer}/headers`, '"headers" values must be strings.')
        bad = true
      } else headers = { ...entry.headers }
    }

    const hasPayload = Object.hasOwn(entry, 'payload')
    const hasFile = Object.hasOwn(entry, 'file')
    let file = null
    if (hasPayload && hasFile) {
      sink.invalid(pointer, 'An event declares either an inline "payload" or a "file", never both: two bodies for one delivery is an ambiguity, not a default.')
      bad = true
    } else if (hasFile) {
      file = readRelativePath(entry, 'file', pointer, sink)
      if (file === null) bad = true
      else if (eventsRoot === null) {
        sink.invalid(`${pointer}/file`, 'An event names a "file" but the plan declares no "eventsRoot" to resolve it inside.', 'Add "eventsRoot" to the plan, or inline the payload.')
        bad = true
      }
    }

    if (id === null) {
      bad = true
      return
    }
    events.push({
      index,
      pointer,
      id,
      type,
      target,
      headers,
      payload: hasPayload ? entry.payload : undefined,
      file,
      fileLabel: file === null ? null : joinRelative(eventsRoot ?? '', file),
    })
  })

  if (raw.length > limits.maxEvents * 4 && raw.length > HARD_LIMITS.maxEvents) {
    // The plan itself is bounded by the CLI byte limit; this only stops a
    // pathological in-memory plan handed straight to the API.
    sink.invalid('/events', `"events" holds ${raw.length} entries, beyond the hard cap of ${HARD_LIMITS.maxEvents}.`)
    bad = true
  }

  return bad ? null : events
}
