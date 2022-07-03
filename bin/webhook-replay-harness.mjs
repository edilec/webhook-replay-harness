#!/usr/bin/env node

import process from 'node:process'

import { MAX_CLOCK_START, exitCodeFor, formatReport, replayPlanFile, serializeReport } from '../src/index.mjs'

const VERSION = '0.1.0'

const HELP = `webhook-replay-harness

Replay sanitized webhook event fixtures into an in-process mock receiver under
virtual time, and report what the receiver did with them.

Delivery is refused for anything but the receiver the plan declares. A fixture
naming an external URL, a non-loopback host, or any endpoint other than that
receiver is refused before an attempt is constructed. No socket is opened, no
hostname is resolved, and nothing leaves this machine -- the receiver is a
function call in this process.

Retries and backoff advance a virtual clock. No run ever sleeps.

Usage:
  webhook-replay-harness --plan FILE [--json] [--label NAME] [--start-ms N] [limits]

Options:
  --plan FILE                Replay plan to run (JSON, max 1 MiB) (required)
  --label NAME               Value recorded as location.file in the report
                             (defaults to the --plan value as written)
  --json                     Suppress the human summary on stderr
  --start-ms N               Virtual clock start, overriding the plan's clock
                             (0 to 8640000000000, the same bound the plan's
                             clock.startMs is held to)
  --max-events N             Maximum events replayed (default 500)
  --max-attempts-per-event N Cap on delivery.maxAttempts (default 10)
  --max-total-attempts N     Maximum attempts across the run (default 5000)
  --max-payload-bytes N      Maximum bytes per event body (default 65536)
  --max-payload-depth N      Maximum nesting depth per event body (default 16)
  --max-virtual-ms N         Maximum virtual time for the run (default 3600000)
  --max-findings N           Maximum findings in the report (default 500)
  -h, --help                 Show this help
  -v, --version              Show the version

Every option that carries a value may be given only once: a repeated flag is a
configuration error, not a silent last-wins. An unknown option is refused, so a
one-character typo cannot quietly turn a real failure into a green run.

Fixtures are read, never written. There is no auto-fix.

Output:
  stdout  the JSON report only, so it can be piped straight into a parser
  stderr  the human summary and diagnostics

Exit codes:
  0  every event replayed to a verdict and the policy was satisfied
  1  the replay completed and the policy failed (a refused delivery, an
     exhausted retry budget, a redelivered duplicate)
  2  invalid usage or configuration (stdout is empty), or evidence that could
     not be obtained (an "incomplete" report on stdout, never a "pass")
`

const LIMIT_FLAGS = new Map([
  ['--max-attempts-per-event', 'maxAttemptsPerEvent'],
  ['--max-events', 'maxEvents'],
  ['--max-findings', 'maxFindings'],
  ['--max-payload-bytes', 'maxPayloadBytes'],
  ['--max-payload-depth', 'maxPayloadDepth'],
  ['--max-total-attempts', 'maxTotalAttempts'],
  ['--max-virtual-ms', 'maxVirtualMs'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  if (argv.includes('-v') || argv.includes('--version')) return { version: true }

  const options = { plan: null, label: null, json: false, startMs: null, limits: {} }
  const given = new Set()

  /**
   * A flag that carries a value is accepted once.
   *
   * Letting it repeat discards the earlier value with no diagnostic, so
   * `--plan a --plan b` replays a plan nobody named and `--max-events 5
   * --max-events 1` enforces a limit nobody asked for. That is the same defect
   * as an ignored typo, which this tool already refuses.
   */
  const once = (name) => {
    if (given.has(name)) throw new Error(`${name} was given more than once`)
    given.add(name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') options.json = true
    else if (argument === '--plan') {
      once('--plan')
      options.plan = takeValue('--plan')
    } else if (argument === '--label') {
      once('--label')
      options.label = takeValue('--label')
    } else if (argument === '--start-ms') {
      once('--start-ms')
      const raw = takeValue('--start-ms')
      if (!/^\d+$/.test(raw)) throw new Error('--start-ms requires a non-negative integer')
      if (Number(raw) > MAX_CLOCK_START) throw new Error(`--start-ms must be no greater than ${MAX_CLOCK_START}`)
      options.startMs = Number(raw)
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${argument} requires a positive integer`)
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    } else throw new Error(`Unknown option "${argument}"`)
  }

  if (options.plan === null) throw new Error('--plan is required')
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    // Configuration never had a subject, so stdout stays empty.
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  let report
  try {
    report = await replayPlanFile(options.plan, {
      ...(options.label === null ? {} : { label: options.label }),
      ...(options.startMs === null ? {} : { startMs: options.startMs }),
      limits: options.limits,
    })
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }

  process.stdout.write(`${serializeReport(report)}\n`)
  if (!options.json) process.stderr.write(formatReport(report))

  if (report.status === 'incomplete') {
    const { checked, events, skipped } = report.summary
    process.stderr.write(
      `incomplete: ${checked} of ${events} declared event(s) reached a verdict and ${skipped} were not replayed. ` +
      `The findings say what was not examined; this is not a pass.\n`,
    )
  }
  return exitCodeFor(report)
}

process.exitCode = await main(process.argv.slice(2))
