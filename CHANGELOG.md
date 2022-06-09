# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Added

- a replay engine that drives sanitized webhook event fixtures into an
  in-process mock receiver, with a status scripted per attempt whose last entry
  repeats, so a fixture can exercise "fail once, then accept" without flakiness;
- an injected virtual clock: retries, backoff and scripted latency advance it
  and nothing else does, so a fixture declaring ninety minutes of backoff
  replays in under a millisecond and the timestamps in the report are a function
  of the fixture alone;
- a delivery policy that refuses anything but the declared receiver — an
  external host, a non-loopback host, a non-HTTP scheme, a URL carrying
  credentials, and any loopback endpoint that is not the one the plan declares
  — decided *before* an attempt is constructed and before the fixture body is
  opened, and reported as an error that fails the run;
- an `allowedHosts` list that can only narrow the policy: the loopback test runs
  first, so listing an external host does not make it deliverable;
- duplicate event id handling in both directions: a repeat the receiver
  deduplicates is a warning, and a repeat it processes again is an error,
  reported whatever status the redelivery then returned, because the hazard is
  the second processing and not the answer;
- a closed retry classification — success, retryable, permanent — so a
  non-retryable status stops immediately rather than burning the retry budget on
  a delivery that was never going to be accepted;
- fixture bodies inline or in files under a declared `eventsRoot`, with
  real-path containment resolved on both sides, so a symlink out of the root is
  refused unread while a fixture genuinely inside a symlinked root is still
  replayed — a false refusal is a bug too;
- refusal of credential-bearing headers by name, because this tool cannot tell a
  live token from a placeholder and a fixture is meant to be sanitized before it
  is stored anywhere;
- strict UTF-8 decoding with `TextDecoder('utf-8', { fatal: true })` for every
  byte source, the plan file included, so whether an input is decodable is the
  decoder's decision and never an inference drawn from the decoded text;
- explicit bounds on events, attempts per event, total attempts, payload bytes,
  payload nesting depth, virtual time, findings and the plan file itself, each
  reported by name and each making the run `incomplete` rather than truncating
  it quietly;
- sanitisation of every untrusted string that reaches output — event ids,
  receiver ids, types, targets, paths, pointers, messages and evidence alike —
  removing C0, DEL, the whole C1 range (where `U+0085` NEL and the 8-bit CSI
  `U+009B` live), the line and paragraph separators, and the bidi formatting
  characters, whose `U+202E` would otherwise reverse everything displayed after
  it;
- deterministic replay ordering, declared or by event id, compared by UTF-16
  code unit so that `Z` precedes `a` and `a-b` precedes `a_b` on every machine;
- result capture in a `replay` object alongside the report envelope: the
  receiver, the ordering, the clock, one record per delivery and one entry per
  attempt the receiver saw, deduplicated ones included;
- a CLI with `--help`, `--version`, `--json`, `--label`, `--start-ms` and the
  limit flags, the JSON report on stdout and nothing else, diagnostics on
  stderr, and exit codes 0 / 1 / 2 — with an empty stdout for a configuration
  error and an `incomplete` report for evidence that could not be obtained, and
  with an unknown option or a repeated value-carrying flag refused rather than
  silently overwriting the earlier value;
- `replayPlan` and `replayPlanFile` as the public API, the first taking a plan
  object and an optional injected clock;
- runnable clean and deliberately broken example plans; the broken one collects
  every refusal in one place;
- the rule catalog, plan schema, status classes, limits, report shape, exit
  codes and the list of things this tool cannot conclude in
  `docs/replay-rules.md`.

### Guaranteed

- No delivery leaves this machine. The receiver is a function call, not a
  socket: this package imports no socket, HTTP, datagram, resolver or TLS
  module, invokes no fetch primitive, and spawns no process.
  `test/no-network.test.mjs` proves it directly — it opens a real listener on a
  real loopback port, declares that exact port as the plan's receiver, replays
  two events into it successfully, and asserts the listener saw no connection
  and no request.
- No run sleeps and no host timer is set. The source contains no timer call of
  any kind, and a replay spending ninety minutes of virtual time is asserted to
  finish in milliseconds of real time.
- Unknown evidence is never a pass. Every path that could report silence as
  health — an unreadable plan, an unreadable fixture, a bound that was hit, a
  run that reached a verdict on nothing — sets `incomplete` and exits 2.
- Two runs over the same bytes produce byte-identical stdout. No wall clock,
  random source, environment variable or locale reaches the output, and nothing
  is discovered by listing a directory.
- Severity is pinned by behaviour rather than by declaration. Each of the eight
  rules whose severity alone decides the verdict is driven through the real
  binary in isolation and its exit code asserted; the seventeen that also mark
  the run incomplete are pinned in a file that imports nothing from `src`, with
  every status, error count and printed severity word written out as a literal.
- Every guarantee above has a test that fails when the guarantee is removed. The
  suite was verified by mutating each one in turn — demoting a severity,
  substituting a collator for the code-unit comparator, dropping the C1 range
  from the strip set, replacing real-path containment with a lexical check,
  removing an `incomplete` flag, unwiring a CLI flag from the engine — and
  watching the corresponding test break.

### Notes

- The report envelope is the Edilec report contract v1. `replay` is an
  additional top-level object carrying the captured result; the four required
  envelope fields are present and unchanged.
- A loopback socket transport is deliberately absent rather than unfinished.
  `transport` accepts `in-process` and nothing else.

No release has been published.
