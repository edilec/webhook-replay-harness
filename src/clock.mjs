/**
 * webhook-replay-harness -- virtual time.
 *
 * Retries and backoff advance this clock. They never call `setTimeout`, never
 * read `Date.now`, and never sleep. Two consequences, both of them the point:
 *
 * 1. A replay of a fixture with a ten-minute backoff finishes instantly, so a
 *    test suite can assert on the timing of the fourth retry without waiting
 *    for it.
 * 2. The timestamps in the report are a function of the fixture alone. Two runs
 *    over the same bytes produce byte-identical output, on any machine, at any
 *    wall-clock time.
 *
 * The clock is injected rather than constructed inside the engine, so a caller
 * can supply its own and observe every advance.
 */

/**
 * A monotonic integer clock that only ever moves when it is told to.
 *
 * Milliseconds are integers throughout: a fractional advance would make the
 * emitted timestamps depend on floating-point accumulation order, which is a
 * determinism hazard for no benefit a webhook fixture could use.
 */
export function createVirtualClock(startMs = 0) {
  if (!Number.isInteger(startMs) || startMs < 0) {
    throw new TypeError('Virtual clock start must be a non-negative integer number of milliseconds')
  }
  let current = startMs

  return Object.freeze({
    startMs,
    now() {
      return current
    },
    advance(ms) {
      if (!Number.isInteger(ms) || ms < 0) {
        throw new TypeError('Virtual clock advance must be a non-negative integer number of milliseconds')
      }
      current += ms
      return current
    },
    elapsedMs() {
      return current - startMs
    },
  })
}

/**
 * The delay before attempt `attempt + 1`, in milliseconds.
 *
 * Integer arithmetic only, and bounded by `maxBackoffMs`, so the sequence a
 * fixture produces is exact rather than approximately exponential. `attempt` is
 * one-based: the wait after the first attempt uses the base delay.
 */
export function backoffDelayMs(attempt, { backoffMs, backoffFactor, maxBackoffMs }) {
  if (!Number.isInteger(attempt) || attempt < 1) throw new TypeError('Attempt must be a positive integer')
  let delay = backoffMs
  for (let step = 1; step < attempt; step += 1) {
    delay *= backoffFactor
    if (delay >= maxBackoffMs) return maxBackoffMs
  }
  return delay > maxBackoffMs ? maxBackoffMs : delay
}
