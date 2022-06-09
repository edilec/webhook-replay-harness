# webhook-replay-harness

Replay sanitized webhook event fixtures into an **in-process mock receiver**, under a **virtual
clock**, with deterministic ordering and a captured result for every delivery. Retries, backoff and
duplicate event ids are exercised locally, in milliseconds, with no socket and no waiting.

- **Repository:** [edilec/webhook-replay-harness](https://github.com/edilec/webhook-replay-harness)
- **Area:** Automation & Workflows
- **License:** MIT
- **Dependencies:** none. Node built-ins only, Node >= 22.

## A delivery never leaves this machine

The receiver is a plain object in the same process. A "delivery" is a function call, so there is no
socket for one to escape through, and no hostname is ever resolved.

A fixture that names an external URL, a non-loopback host, a non-HTTP scheme, a URL carrying
credentials, or any loopback endpoint other than the receiver the plan declares is **refused before
an attempt is constructed** — before its fixture body is even opened. That refusal is an `error`: it
fails the run with exit 1.

This is structural rather than a policy the tool could be argued out of. The package imports no
socket, HTTP, datagram, resolver or TLS module, invokes no fetch primitive, and spawns no process.
`test/no-network.test.mjs` proves it the direct way: it opens a real HTTP listener on a real loopback
port, declares that exact port as the plan's receiver, replays two events into it successfully, and
asserts the listener saw **zero connections and zero requests**.

`allowedHosts` can only ever narrow the policy. Listing `hooks.example.com` in it does not make that
host deliverable, because the loopback test is applied first and there is no way to spell past it.

## Time is virtual

Retries and backoff advance an injected clock. Nothing schedules a host timer and no run sleeps, so a
fixture with ninety minutes of backoff replays in under a millisecond and the timestamps in the
report are a function of the fixture alone. The clock can be injected outright by an API caller, or
started anywhere with `--start-ms`.

## Install

```sh
npm install webhook-replay-harness
```

Or run it from a checkout with no install at all:

```sh
node bin/webhook-replay-harness.mjs --plan examples/clean/plan.json
```

## Use

```sh
webhook-replay-harness --plan fixtures/orders.json
webhook-replay-harness --plan fixtures/orders.json --json
webhook-replay-harness --plan fixtures/orders.json --start-ms 86400000 --max-events 50
```

The JSON report goes to **stdout and nothing else**, so it pipes straight into a parser. The human
summary and every diagnostic go to **stderr**; `--json` silences the summary.

```
4 of 4 event(s) replayed to a verdict: 0 error, 1 warning, 1 info, status pass.
receiver: orders-receiver at http://127.0.0.1:8787/hooks/orders (in-process). No socket was opened and nothing left this machine.
outcomes: 3 delivered, 1 deduplicated, 0 refused, 0 failed, 0 not replayed.
attempts: 5 total, 1 of them retries, across 274ms of virtual time.
INFO    examples/clean/plan.json/events/1 delivery-retried Event "evt_order_updated" was accepted on
        attempt 2 of 3, after 1 retry(s) under virtual time. -- final status 200 at 274ms
WARNING examples/clean/plan.json/events/2 duplicate-event-id-deduplicated Event id
        "evt_order_updated" arrived again and the receiver deduplicated it, answering 200 without
        processing it a second time. -- attempt 1, answered 200
```

The deliberately broken example collects the refusals in one place:

```
ERROR   examples/broken/plan.json/events/0/target target-host-not-allowed Delivery refused before
        any attempt: host "hooks.example.com" is not a loopback address. Event "evt_external" was
        not sent anywhere, and nothing left this machine. -- https://hooks.example.com/inbound
ERROR   examples/broken/plan.json/events/1/target target-not-declared-receiver Delivery refused
        before any attempt: the target is loopback but is not the declared receiver, so event
        "evt_other_port" was not sent anywhere.
```

## The plan

One JSON file declares the receiver, the delivery policy and the events. Every key is closed: an
unknown one is refused rather than ignored, so a one-character typo cannot quietly turn a real
failure into a green run.

```json
{
  "receiver": {
    "id": "orders-receiver",
    "transport": "in-process",
    "url": "http://127.0.0.1:8787/hooks/orders",
    "defaultStatus": 200,
    "dedupe": true,
    "script": [{ "event": "evt_order_updated", "statuses": [503, 200], "latencyMs": 12 }]
  },
  "allowedHosts": ["127.0.0.1"],
  "ordering": "fixture",
  "clock": { "startMs": 0 },
  "delivery": { "maxAttempts": 3, "backoffMs": 250, "backoffFactor": 2, "maxBackoffMs": 5000 },
  "eventsRoot": "events",
  "events": [
    { "id": "evt_order_created", "type": "order.created", "file": "order-created.json" },
    { "id": "evt_order_updated", "type": "order.updated", "file": "order-updated.json" },
    { "id": "evt_order_shipped", "type": "order.shipped", "payload": { "orderId": "A-1041" } }
  ]
}
```

`script` gives the receiver a status per attempt, and its last entry repeats: `[503, 200]` means
"fail once, then accept for ever". A fixture body is inline in `payload`, or in a JSON file under
`eventsRoot` — never both, because two bodies for one delivery is an ambiguity rather than a default.

Every fixture file is resolved to its **real** path and checked against the **real** events root, so
a symlink planted inside the root is refused unread — and a fixture genuinely inside a root that is
itself reached through a symlink is still replayed. A false refusal is a bug too.

The full rule catalog, plan schema, limits and report shape are in
[`docs/replay-rules.md`](./docs/replay-rules.md).

## The report

The envelope is the Edilec report contract: `schemaVersion`, `tool`, `status`, `summary`,
`findings`. This tool adds one top-level object, `replay`, which is the captured result:

```json
{
  "replay": {
    "receiver": { "id": "orders-receiver", "url": "http://127.0.0.1:8787/hooks/orders", "transport": "in-process", "dedupe": true },
    "ordering": "fixture",
    "clock": { "startMs": 0, "endMs": 274 },
    "deliveries": [
      { "order": 2, "eventId": "evt_order_updated", "type": "order.updated", "source": "events/order-updated.json",
        "outcome": "delivered", "attempts": 2, "finalStatus": 200, "deduplicated": false,
        "firstAttemptAtMs": 0, "lastAttemptAtMs": 274 }
    ],
    "receiverLog": [
      { "sequence": 2, "eventId": "evt_order_updated", "attempt": 1, "atMs": 0, "status": 503, "deduplicated": false }
    ]
  }
}
```

`deliveries` is the replay order. `receiverLog` is every attempt the receiver saw, in the order it
saw them — including the ones it deduplicated.

## Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | every declared event reached a verdict and the policy was satisfied |
| `1` | the replay completed and the policy failed |
| `2` | invalid usage or configuration (**stdout is empty**), or evidence that could not be obtained (an `incomplete` report on stdout) |

A configuration error means the run never had a subject, so there is nothing to report about. An
input that could not be read means the run had a subject and failed to get evidence about it, which
is exactly what `incomplete` exists to say — so that report is written, and it is never a `pass`.

## Determinism

Two runs over the same bytes produce byte-identical stdout. Ordering is by UTF-16 code unit, never by
collation: `Z` precedes `a`, `a-b` precedes `a_b`, and `README` precedes `assets`, on every machine.
No wall clock, no random source, no environment variable and no locale reaches the output, and
nothing is ever discovered by listing a directory — every fixture is named explicitly by the plan.

Every untrusted string that reaches output — event ids, receiver ids, types, targets, paths,
pointers, messages, evidence — is stripped of C0, DEL, the whole C1 range (where `U+0085` NEL and the
8-bit CSI `U+009B` live), the line and paragraph separators, and the bidi formatting characters
(whose `U+202E` would otherwise reverse everything displayed after it).

## Limits and non-goals

**What this tool cannot conclude.** It replays fixtures into a mock. It says nothing about the real
receiver.

- **It does not test your webhook endpoint.** The receiver is a script of status codes you wrote.
  A green run means your fixtures drove that script the way you expected — not that the service
  behind that URL would answer the same way, or at all.
- **It cannot verify a signature, and refuses to try.** A fixture carrying `Authorization`,
  `Cookie`, `X-Hub-Signature`, `X-API-Key` or any other credential-bearing header is refused by
  header name. This tool cannot tell a live token from a placeholder, and a fixture is meant to be
  sanitized before it is stored anywhere. Strip the header; script the status you need instead.
- **It proves nothing about your production retry behaviour.** The backoff is the arithmetic the
  plan declares, on a clock that only this tool advances. A real sender's jitter, connection
  timeouts, DNS failures and queue depth are all outside it.
- **Virtual time is not latency measurement.** `virtualElapsedMs` is the sum of the delays the plan
  declared. It is not how long anything took.
- **Dedupe is the mock's dedupe.** `duplicate-event-id-deduplicated` says this harness's in-process
  receiver suppressed a repeat id. Whether your real receiver is idempotent is a question about your
  receiver.
- **A loopback socket transport is deliberately absent**, not unfinished. Binding a port would mean
  a fixture could reach whatever else happens to be listening on it. `transport` accepts
  `in-process` and nothing else.
- **`localhost` is accepted as the literal name it is.** No resolver is consulted — since no socket
  is opened, a hosts file pointing it elsewhere cannot turn a function call into a request.
- **Nothing is written.** Fixtures are read-only and there is no auto-fix.
- **A bound that was hit is not a smaller answer.** Every limit — events, attempts per event, total
  attempts, payload bytes, payload nesting depth, virtual time, findings, and the 1 MiB plan file —
  is reported by name and makes the run `incomplete`. It never truncates silently, and never passes.
- **A run that reached a verdict on no event is `incomplete`, never `pass`.** Green on no evidence is
  a defect, not a clean bill of health.

## Verify

```sh
npm run check
```

`check` runs `lint` (a syntax check of every shipped file), the full test suite, the clean example,
and a packaging dry run. Every guarantee stated above has a test that fails when the guarantee is
removed — the suite was verified by mutating each one in turn and watching it break.

## License

MIT. See [LICENSE](./LICENSE).
