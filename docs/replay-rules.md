# Replay rules, plan schema and limits

Reference for `webhook-replay-harness`. The authoritative severity table lives in
`src/rules.mjs`; this document records the same catalog for a reader, and the behaviour of every
rule in it is pinned by tests that run the real binary.

## The rule catalog

Severity decides the verdict: any `error` fails the run, a `warning` or `info` does not. Rules that
also mark the run `incomplete` exit 2 whatever their severity says.

### Policy — a delivery that was refused

These are verdicts this harness reached. The run completed; the fixture set failed.

| Rule | Severity | Raised when |
| --- | --- | --- |
| `target-host-not-allowed` | `error` | The target host is not a loopback address, or is loopback but not in `allowedHosts`. Refused before any attempt. |
| `target-not-declared-receiver` | `error` | The target is loopback and allowed, but is not the endpoint the plan declares as its receiver. |
| `target-url-invalid` | `error` | The target is not an absolute URL, not `http`/`https`, or carries credentials in the URL. |
| `event-header-credential` | `error` | The fixture carries a credential-bearing header. Refused by header name; see [Credential headers](#credential-headers). |
| `event-file-outside-root` | `error` | The fixture file resolves outside the real events root. Refused unread; its contents never reach the report. |

For `target-not-declared-receiver`, the evidence names the first differing UTF-16 code-unit
offset and values in the parsed URL keys (origin, path and query). This remains unambiguous when
the raw spellings contain invisible characters or share a prefix longer than an excerpt can show.

### Delivery outcomes

| Rule | Severity | Raised when |
| --- | --- | --- |
| `delivery-exhausted-retries` | `error` | Every attempt failed and the retry budget ran out. |
| `delivery-rejected-permanently` | `error` | The receiver answered a non-retryable status, so no retry was attempted. |
| `duplicate-event-id-redelivered` | `error` | An event id reached the receiver a second time and was not deduplicated — the same event was processed twice. |
| `duplicate-event-id-deduplicated` | `warning` | An event id arrived again and the receiver deduplicated it, answering without reprocessing. |
| `delivery-retried` | `info` | The event was accepted, but not on the first attempt. |

### Evidence that could not be obtained

Each of these also sets `incomplete`, so the run exits 2.

| Rule | Severity | Raised when |
| --- | --- | --- |
| `plan-unreadable` | `error` | The plan file could not be opened, or is not a regular file. |
| `plan-not-utf8` | `error` | The plan file is not valid UTF-8. |
| `plan-not-json` | `error` | The plan file is not valid JSON. |
| `plan-invalid` | `error` | The plan does not match the schema below. |
| `plan-unknown-key` | `error` | The plan declares a key the schema does not define. |
| `receiver-not-declared-local` | `error` | The declared receiver itself is not a permitted local endpoint. Nothing is replayed. |
| `event-file-unreadable` | `error` | A fixture file, or the events root, could not be read. |
| `event-file-not-utf8` | `error` | A fixture file is not valid UTF-8. |
| `event-file-not-json` | `error` | A fixture file is not valid JSON. |
| `no-events-replayed` | `error` | No event reached a verdict, so the run checked nothing. |

### Bounds

Each of these also sets `incomplete`. A bound that was hit is never a smaller answer.

| Rule | Severity | Raised when |
| --- | --- | --- |
| `limit-plan-bytes-exceeded` | `error` | The plan file is larger than 1 MiB. |
| `limit-events-exceeded` | `error` | The plan declares more events than `maxEvents`. |
| `limit-total-attempts-exceeded` | `error` | The run reached `maxTotalAttempts`. |
| `limit-virtual-time-exceeded` | `error` | A backoff would take virtual time past `maxVirtualMs`. |
| `limit-payload-bytes-exceeded` | `error` | An event body is larger than `maxPayloadBytes`. |
| `limit-payload-depth-exceeded` | `error` | An event body nests deeper than `maxPayloadDepth`. |
| `limit-findings-exceeded` | `error` | The report would hold more findings than `maxFindings`. The report is partial and says so. |

## The plan schema

Every key listed is the complete set for its level. A key outside it is `plan-unknown-key` and stops
the replay: an ignored key checks nothing at all, and a one-character typo must never be the reason a
real failure came back green.

### Top level

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `receiver` | object | — | **Required.** The one endpoint deliveries may reach. |
| `events` | array | — | **Required.** The event fixtures, in declared order. |
| `eventsRoot` | string | absent | Directory, relative to the plan file, holding fixture bodies. A parent segment is permitted (`../fixtures` is the ordinary way to share one fixture set between sibling plans); every fixture inside it is still resolved to its real path and checked against the real root. |
| `allowedHosts` | string[] | `["127.0.0.1", "::1", "localhost"]` | Hosts permitted **within** the loopback set. Narrows only. |
| `ordering` | `"fixture"` or `"eventId"` | `"fixture"` | Replay order. `eventId` sorts by UTF-16 code unit, ties broken by declared order. |
| `clock` | object | `{ "startMs": 0 }` | Where the virtual clock starts. `startMs` is an integer from 0 to 8640000000000 — the largest instant a `Date` can represent, since a virtual clock may start at a real epoch timestamp. `--start-ms` overrides it and is held to the same bound. |
| `delivery` | object | see below | The retry policy. |
| `limits` | object | see below | Bounds for this run. |

### `receiver`

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `id` | string | — | **Required.** Name recorded in the capture. |
| `url` | string | — | **Required.** Must be a loopback `http`/`https` URL whose host is in `allowedHosts`. |
| `transport` | `"in-process"` | `"in-process"` | The only supported value. |
| `defaultStatus` | integer 100–599 | `200` | Answer for an event with no script rule. |
| `dedupe` | boolean | `true` | Whether the receiver suppresses an id it has already accepted. |
| `dedupeStatus` | integer 100–599 | `200` | Answer given to a suppressed redelivery. |
| `latencyMs` | integer >= 0 | `0` | Virtual time each unscripted attempt consumes. |
| `script` | array | `[]` | Rules of `{ event, statuses, latencyMs }`. |

A script rule's `statuses` gives the answer per attempt, and its **last entry repeats**: `[503, 200]`
means "fail once, then accept for ever". A rule naming an event the plan does not declare is
`plan-invalid` — a scripted retry nobody wired up would otherwise look like a plain success.
Matching uses the raw event id. If a script id differs from a declared id but both render the same
in the report, the finding identifies that ambiguity and the declared event's pointer; it does not
claim the visible id is absent.

### `delivery`

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `maxAttempts` | integer 1–`maxAttemptsPerEvent` | `3` | Attempts per event, the first included. Above the limit it is `plan-invalid` at `/delivery/maxAttempts`, and the message names `maxAttemptsPerEvent` as the bound that rejected it. |
| `backoffMs` | integer >= 0 | `1000` | Delay before the second attempt. |
| `backoffFactor` | integer 1–10 | `2` | Multiplier per further attempt. Integer, so the sequence is exact. |
| `maxBackoffMs` | integer >= 0 | `60000` | Ceiling the sequence stops at. |

The delay before attempt *n + 1* is `min(maxBackoffMs, backoffMs * backoffFactor^(n - 1))`.

### `events[]`

| Key | Type | Meaning |
| --- | --- | --- |
| `id` | string | **Required.** Repeating one exercises the dedupe path. |
| `type` | string | Optional label, recorded in the capture. |
| `target` | string | Optional. Defaults to the receiver's URL. |
| `headers` | object | Optional, at most 32 string values. Credential-bearing names are refused. |
| `payload` | any JSON | Optional inline body. |
| `file` | string | Optional path under `eventsRoot`. Mutually exclusive with `payload`. |

The receiver and event ids must remain non-empty after report sanitisation. Two different raw event
ids that render identically make the plan incomplete, since the capture could not distinguish them;
repeating the *same* raw id remains valid and exercises deduplication.

### Status classes

| Class | Statuses | Effect |
| --- | --- | --- |
| Success | `200`–`299` | The event is accepted, and its id is committed to the dedupe set. |
| Retryable | `408`, `425`, `429`, `500`–`599` | Another attempt is made, after the backoff. |
| Permanent | everything else | Stops immediately. Treating a `403` as retryable would burn the budget on a delivery that was never going to be accepted. |

## Credential headers

Refused by name, unconditionally: `authorization`, `cookie`, `proxy-authorization`, `set-cookie`,
`x-amz-security-token`, `x-api-key`, `x-auth-token`, `x-hub-signature`, `x-hub-signature-256`,
`x-signature`, `x-webhook-secret`.

**That list is closed, and it is these eleven names.** A provider-specific credential header outside
it — `x-gitlab-token`, `x-shopify-hmac-sha256`, and every other one a vendor invents — is treated as
an ordinary header and delivered. This tool refuses the names it knows; it does not guess at the
rest, and it is not a secret scanner. Sanitize the fixture before you store it.

This tool cannot tell `Bearer REDACTED` from a live token, and guessing is the wrong behaviour for a
file that is about to be committed to a repository. Strip the header from the fixture. If the
receiver under test is supposed to reject an unsigned request, script the status it should answer
with instead.

## What a refusal repeats back

A finding names the document and what was wrong with it. It does not reproduce the document.

Sanitising alone does not achieve that, and both JSON reads -- the plan file and every fixture --
proved it. V8 reports an invalid document two ways, and one of them embeds the input:
`Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON` reproduces a short document in
full, and a longer one through a window around the offence. `sanitize` replaces control characters
and cuts from the end, so a quoted span sitting at the front passed through it untouched and well
inside the limit.

`plan-not-json` and `event-file-not-json` now keep only the useful half -- the position, line and
column where V8 reports them, and the offending token where it does not -- and still sanitise the
result, because that token is one character the document chose. Stripping control characters and
declining to repeat the input are two different guarantees, and both are wanted here: a document
that fails to parse is a document nothing has validated.

## Limits

| Limit | Default | Hard cap |
| --- | ---: | ---: |
| `maxEvents` | 500 | 5000 |
| `maxAttemptsPerEvent` | 10 | 50 |
| `maxTotalAttempts` | 5000 | 50000 |
| `maxPayloadBytes` | 65536 | 1048576 |
| `maxPayloadDepth` | 16 | 64 |
| `maxVirtualMs` | 3600000 | 604800000 |
| `maxFindings` | 500 | 5000 |

The plan file itself is bounded at 1 MiB, and the virtual clock start at 8640000000000. Neither is
configurable.

Seven of these limits are reported during the replay by a `limit-*` rule, which also marks the run
`incomplete`. `maxAttemptsPerEvent` is the exception in form only: it bounds `delivery.maxAttempts`
while the plan is validated, before anything is replayed, so it is reported as `plan-invalid` at
`/delivery/maxAttempts` with the limit named in the message — and that also makes the run
`incomplete`. No limit is ever applied silently.

### Structural bounds

These shape the plan rather than the run, so they are fixed rather than configurable. Exceeding one
is `plan-invalid`.

| Structure | Bound |
| --- | ---: |
| `allowedHosts` entries | 16 |
| `receiver.script` rules | 1000 |
| `statuses` per script rule | 32 |
| `headers` per event | 32 |
| an id, a type or a receiver name | 200 characters |
| a declared path (`eventsRoot`, `file`) | 400 characters |

Limits layer: the defaults, then the plan's `limits`, then the CLI flags. A plan may lower a limit
and may never raise one past its hard cap. An unknown limit name is refused, not ignored.

## The report

```json
{
  "schemaVersion": "1",
  "tool": "webhook-replay-harness",
  "status": "pass",
  "summary": {
    "checked": 4, "errors": 0, "warnings": 1, "info": 1,
    "events": 4, "delivered": 3, "deduplicated": 1, "refused": 0, "failed": 0, "skipped": 0,
    "attempts": 5, "retries": 1, "virtualElapsedMs": 274
  },
  "findings": [],
  "replay": { "receiver": {}, "ordering": "fixture", "clock": {}, "deliveries": [], "receiverLog": [] }
}
```

`checked` counts the events that reached a **verdict**: delivered, deduplicated, refused, rejected or
exhausted. An event a limit stopped short of, or whose fixture could not be read, is counted in
`skipped` and never in `checked` — which is why `pass` with `checked: 0` is not reachable.

A delivery's `outcome` is one of `delivered`, `deduplicated`, `refused`, `rejected`, `exhausted` or
`skipped`.

Findings sort by `location.file`, then `location.pointer`, then `ruleId`, then `message`, then
`evidence` — every comparison by UTF-16 code unit.

`location.file` is the plan label: the `--plan` value exactly as written, or `--label` when that is
given. `location.pointer` is a JSON Pointer into the plan, so the two always name the same document.
A finding about a fixture file names that file by its **declared relative path** in `evidence`, and
`replay.deliveries[].source` records it too. No resolved host path reaches the report from anywhere:
the only absolute path a report can carry is one the caller passed to `--plan` itself.

## Exit codes

| Code | stdout | Meaning |
| ---: | --- | --- |
| `0` | the report | Every declared event reached a verdict and the policy was satisfied. |
| `1` | the report | The replay completed and the policy failed. |
| `2` | **empty** | Invalid usage or configuration: the run never had a subject. |
| `2` | the report, `status: "incomplete"` | The run had a subject and could not get evidence about it. |

## What this tool cannot conclude

See "Limits and non-goals" in the README. In short: it replays fixtures into a mock whose answers
you wrote. A green run says the fixtures drove that mock as expected. It says nothing about the
service behind the URL, nothing about a real sender's retry behaviour, nothing about real latency,
and nothing about whether your receiver is idempotent.
