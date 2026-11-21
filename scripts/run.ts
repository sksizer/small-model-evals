// Runs every suite against every model, one model at a time, and appends the
// scored cases to the ledger (scripts/ledger.ts). The loop itself is
// scripts/run-core.ts, shared with the queue worker (scripts/queue.ts), which
// runs prepared jobs when the machine is free.
//
//   bun scripts/run.ts                       everything this machine's profile allows and that fits
//   bun scripts/run.ts --plan                print what would run, with each model's memory fit; run nothing
//   bun scripts/run.ts --models qwen3:4b,granite4 --suites extract,classify
//   bun scripts/run.ts --category vision,search --cost light
//   bun scripts/run.ts --profile nvidia-24g  use machines/nvidia-24g.yaml (default: matched by machine key or class)
//   bun scripts/run.ts --force               run models that will not fit this machine's memory anyway
//   bun scripts/run.ts --suites search --kinds docs   only the cases of one kind (a provider's `config.kinds`)
//   bun scripts/run.ts --suites perf --repeat 5       run every case 5 times (the ledger keeps each; timings become medians)
//
// Before running it prints the plan (scripts/plan.ts) and warns when the machine is busy
// (scripts/conditions.ts); it samples the same conditions around every eval and writes them
// to results/conditions/<run>.json.
//
// promptfoo's raw output lands in results/runs/<timestamp>/ (not committed);
// the records go to results/ledger/, and results/summary.md is rewritten.
import { parseArgs } from 'node:util'
import { problems, sample } from './conditions.ts'
import { machine } from './machine.ts'
import { buildPlan, printPlan, SELECTION_OPTIONS, selectionOf } from './plan.ts'
import { runnableProblem, runPlan } from './run-core.ts'
import { summarize } from './summarize.ts'

const { values } = parseArgs({ options: { ...SELECTION_OPTIONS, kinds: { type: 'string' }, plan: { type: 'boolean' }, repeat: { type: 'string' } } })
const onlyKinds = values.kinds ? new Set(values.kinds.split(',')) : undefined
const repeat = values.repeat ? Number(values.repeat) : undefined
if (repeat !== undefined && !(Number.isInteger(repeat) && repeat >= 1)) throw new Error(`--repeat must be a whole number of 1 or more, got "${values.repeat}"`)

const plan = await buildPlan({
  machine: machine(),
  selection: selectionOf(values),
  profile: values.profile,
  force: values.force,
  extraSkip: runnableProblem,
})
printPlan(plan)
const busy = problems(sample(), { load: true })
if (busy.length > 0) {
  console.log(`\n!! THIS MACHINE IS BUSY. Timings and memory readings from this run will be skewed (the run records this):\n${busy.map((b) => `   - ${b}`).join('\n')}`)
}
if (values.plan) process.exit(0)

const { failures } = await runPlan({ plan, onlyKinds, repeat })

console.log(`\nSummary: ${summarize()}`)
if (failures.length > 0) {
  console.error(`Runs that errored:\n${failures.join('\n')}`)
  process.exit(1)
}
