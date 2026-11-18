// The run queue's command line. See scripts/queue-lib.ts for the job format.
//
//   bun scripts/queue.ts add --suites classify,extract --models all --reason "new prompt" [--priority 5]
//                            [--needs load=0.3,free=4,quiet=10,ac=true,class=apple-16g] [--repeat 5] [--kinds docs]
//   bun scripts/queue.ts sync [--dry-run]   enqueue every (model, suite) that is stale or missing on this machine, one job per suite (--dry-run: say what it would queue)
//   bun scripts/queue.ts list          the open jobs, with the time each should take and whether this machine fits it
//   bun scripts/queue.ts drop <id>     remove a job (--force for a running one)
//   bun scripts/queue.ts work          run jobs as the machine allows (below)
//
// work [--once] [--max-hours N] [--watch] [--poll-seconds N]
//   Takes the open job with the highest priority (a running one first: it resumes), waits until its `needs` hold
//   (the machine is sampled every --poll-seconds, 30 by default; `quiet_minutes` means the needs must hold
//   continuously that long), then runs its evals through the same code as scripts/run.ts. Between two evals it
//   checks again and, if the machine got busy, pauses (the job stays `running`) until it is quiet again. Kill it
//   any time: a restart resumes from the evals not yet recorded as done.
//   --once          run one job and stop
//   --max-hours N   start no eval after N hours (an eval already running finishes)
//   --watch         when no job is waiting, keep checking for new ones (for a service) instead of exiting
// Only one worker runs at a time (queue/.worker.lock).
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { sample } from './conditions.ts'
import { latest } from './ledger.ts'
import { describe, machine } from './machine.ts'
import { buildPlan, printPlan, selectionOf, suiteLabels, type Plan } from './plan.ts'
import { evalKey, evalsOf, runnableProblem, runPlan, type EvalId } from './run-core.ts'
import {
  QUEUE_DIR,
  byTurn,
  dropJob,
  estimate,
  hours,
  jobEvals,
  makeJob,
  newId,
  open,
  parseNeeds,
  readJob,
  readJobs,
  unmet,
  writeJob,
  type Job,
  type Needs,
} from './queue-lib.ts'
import { summarize } from './summarize.ts'

const csv = (v: string | undefined) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [])
const host = machine()
const hostClass = describe(host).class

/** What `sync` asks for: leave the machine alone, as a hand run is told to. */
const DEFAULT_NEEDS: Needs = { max_load_per_core: 0.5, min_free_gib: 3, quiet_minutes: 5, ac_power: true }

const planFor = (job: Job): Promise<Plan> =>
  buildPlan({
    machine: host,
    selection: selectionOf({ models: job.models.join(','), suites: job.suites.join(',') }),
    profile: job.needs.profile,
    extraSkip: runnableProblem,
  })

const onlyKinds = (job: Job) => (job.kinds && job.kinds.length > 0 ? new Set(job.kinds) : undefined)

// ---- add / sync ----------------------------------------------------------------

async function modelsOf(models: string | undefined, suites: string[]): Promise<string[]> {
  if (models && models !== 'all') return csv(models)
  const labels = await Promise.all(suites.map(async (s) => [...(await suiteLabels(s)).keys()]))
  return [...new Set(labels.flat())]
}

async function add(v: { models?: string; suites?: string; reason?: string; priority?: string; needs?: string; repeat?: string; kinds?: string }): Promise<void> {
  if (!v.suites || !v.reason) throw new Error('add needs --suites and --reason (--models defaults to every model of those suites)')
  const suites = csv(v.suites)
  const models = await modelsOf(v.models, suites)
  selectionOf({ models: models.join(','), suites: suites.join(',') }) // names the models and suites that do not exist
  const job = makeJob({
    reason: v.reason,
    models,
    suites,
    ...(v.kinds ? { kinds: csv(v.kinds) } : {}),
    priority: v.priority === undefined ? 0 : Number(v.priority),
    needs: parseNeeds(v.needs),
    ...(v.repeat ? { repeat: Number(v.repeat) } : {}),
  })
  writeJob(job)
  console.log(`queued ${job.id}: ${job.models.length} models × ${job.suites.length} suites`)
}

/** Every (model, suite) a machine could run (per the default plan) whose results here are stale or missing, grouped by suite, minus what an open job already covers. */
export async function stale(): Promise<{ suite: string; models: string[]; stale: number; missing: number }[]> {
  const plan = await buildPlan({ machine: host, selection: {}, extraSkip: runnableProblem })
  const view = latest().filter((v) => v.machine === host.key)
  const covered = new Set(readJobs().filter(open).flatMap((j) => j.models.flatMap((m) => j.suites.filter((s) => !j.done.some((d) => d.startsWith(`${m}·${s}`))).map((s) => `${m}\u0000${s}`))))
  const bySuite = new Map<string, { models: string[]; stale: number; missing: number }>()
  for (const row of plan.rows) {
    if (row.skip) continue
    for (const suite of row.suites) {
      if (covered.has(`${row.model.label}\u0000${suite}`)) continue
      const have = view.find((v) => v.model === row.model.label && v.suite === suite)
      const reason = !have ? 'missing' : have.stale || have.missing.length > 0 ? 'stale' : null
      if (!reason) continue
      const g = bySuite.get(suite) ?? { models: [], stale: 0, missing: 0 }
      g.models.push(row.model.label)
      g[reason === 'stale' ? 'stale' : 'missing']++
      bySuite.set(suite, g)
    }
  }
  return [...bySuite].map(([suite, g]) => ({ suite, ...g }))
}

async function sync(dryRun: boolean): Promise<void> {
  const groups = await stale()
  if (groups.length === 0) return void console.log('nothing stale or missing on this machine that is not already queued')
  for (const g of groups) {
    const parts = [g.stale ? `${g.stale} stale` : '', g.missing ? `${g.missing} not run yet` : ''].filter(Boolean).join(', ')
    const job = makeJob({ id: newId(`sync ${g.suite}`), reason: `sync: ${g.suite} ${parts}`, models: g.models, suites: [g.suite], needs: { ...DEFAULT_NEEDS, class: hostClass } })
    if (!dryRun) writeJob(job)
    console.log(`${dryRun ? 'would queue' : 'queued'} ${job.id}: ${g.suite}, ${g.models.length} models (${parts})`)
  }
}

// ---- list ----------------------------------------------------------------------

const needsLine = (n: Needs) =>
  [
    n.max_load_per_core !== undefined ? `load<=${n.max_load_per_core}/core` : '',
    n.min_free_gib !== undefined ? `free>=${n.min_free_gib}G` : '',
    n.max_swap_gib !== undefined ? `swap<=${n.max_swap_gib}G` : '',
    n.quiet_minutes ? `quiet ${n.quiet_minutes}m` : '',
    n.ac_power ? 'AC' : '',
    n.class ? `class ${n.class}` : '',
    n.profile ? `profile ${n.profile}` : '',
  ]
    .filter(Boolean)
    .join(' ') || 'anything'

async function list(): Promise<void> {
  const jobs = readJobs().sort(byTurn)
  const shown = jobs.filter(open)
  const view = latest()
  const now = sample()
  console.log(`Machine  ${host.key} · class ${hostClass}`)
  console.log(`Now      load ${now.load_per_core}/core · ${now.mem_available_gib} GiB free · swap ${now.swap_used_gib} GiB · ${now.power}${now.busy.length ? ` · busy: ${now.busy.map((b) => b.name).join(', ')}` : ''}`)
  if (shown.length === 0) return void console.log(`\nNo open jobs (${jobs.length} done or failed in queue/).`)
  let total = 0
  console.log('')
  for (const j of shown) {
    const plan = await planFor(j)
    const evals = evalsOf(plan, onlyKinds(j)).filter((e) => !j.done.includes(evalKey(e)))
    const skipped = plan.rows.filter((r) => r.skip)
    const all = (await jobEvals(j)).filter((e) => !j.done.includes(evalKey(e)))
    const est = estimate(all, j.repeat ?? 1, view, host.key)
    const wrongClass = j.needs.class !== undefined && j.needs.class !== hostClass
    const fits = wrongClass ? `no: needs class ${j.needs.class}` : evals.length === 0 ? `no: ${skipped.length > 0 ? `${skipped.length} models skipped (${skipped[0]!.skip!.slice(0, 40)}…)` : 'nothing to run'}` : skipped.length > 0 ? `yes, ${skipped.length} models skipped` : 'yes'
    const ready = unmet(now, j.needs)
    if (!wrongClass) total += evals.length > 0 ? est.ms : 0
    console.log(`${j.id}  [${j.status}]  priority ${j.priority}${j.repeat && j.repeat > 1 ? `  repeat ${j.repeat}` : ''}`)
    console.log(`  ${j.reason}`)
    console.log(`  ${j.suites.join(', ')} · ${j.models.length} models · ${all.length} evals left${j.done.length ? ` (${j.done.length} done)` : ''} · about ${hours(est.ms)}${est.guessed ? ` (${est.guessed} evals guessed: no history)` : ''}`)
    console.log(`  needs ${needsLine(j.needs)} · fits this machine: ${fits} · ${ready.length === 0 ? 'machine meets the needs now' : `not now: ${ready.join('; ')}`}`)
    if (j.notes) console.log(`  notes: ${j.notes}`)
  }
  console.log(`\n${shown.length} open jobs, about ${hours(total)} of compute that fits this machine`)
}

// ---- work ----------------------------------------------------------------------

const LOCK = join(QUEUE_DIR, '.worker.lock')

function takeLock(): void {
  if (existsSync(LOCK)) {
    const pid = Number(readFileSync(LOCK, 'utf8').trim())
    let alive = false
    try {
      process.kill(pid, 0)
      alive = true
    } catch {
      // no such process: a stale lock from a killed worker
    }
    if (alive) throw new Error(`another worker (pid ${pid}) holds ${LOCK}`)
  }
  writeFileSync(LOCK, `${process.pid}\n`)
}

const releaseLock = () => {
  try {
    unlinkSync(LOCK)
  } catch {
    // already gone
  }
}

/** Thrown from a run hook to end the job gracefully: out of time, or the job was dropped or edited out of `running`. */
class Stop extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const stamp = () => new Date().toTimeString().slice(0, 8)

async function work(v: { once?: boolean; 'max-hours'?: string; watch?: boolean; 'poll-seconds'?: string }): Promise<void> {
  takeLock()
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      releaseLock()
      process.exit(130)
    })
  }
  const deadline = v['max-hours'] ? Date.now() + Number(v['max-hours']) * 3_600_000 : Infinity
  const poll = Number(v['poll-seconds'] ?? 30) * 1000
  try {
    while (Date.now() < deadline) {
      const next = readJobs()
        .filter(open)
        .filter((j) => j.needs.class === undefined || j.needs.class === hostClass)
        .sort(byTurn)[0]
      if (!next) {
        if (!v.watch) return void console.log('no open job for this machine')
        await sleep(poll * 2)
        continue
      }
      const stopped = await runJob(next, { poll, deadline })
      if (stopped === 'time' || v.once) return
    }
    console.log('--max-hours reached; no new eval started')
  } finally {
    releaseLock()
  }
}

/** Waits until the needs hold (and, before a job starts, have held for `quiet_minutes`). Returns whether it had to wait. */
async function waitForMachine(job: Job, mid: boolean, poll: number, deadline: number): Promise<boolean> {
  let waited = false
  let quietSince: number | null = null
  let lastSaid = ''
  let lastAt = 0
  for (;;) {
    if (Date.now() >= deadline) throw new Stop('time')
    const why = unmet(sample(), job.needs, mid && !waited)
    const quietMs = (job.needs.quiet_minutes ?? 0) * 60_000
    if (why.length === 0) {
      quietSince ??= Date.now()
      // Mid-job and never paused: the machine was quiet a moment ago, no new window.
      if (Date.now() - quietSince >= quietMs || (mid && !waited)) return waited
      why.push(`quiet for ${Math.round((Date.now() - quietSince) / 60_000)} of ${job.needs.quiet_minutes} min`)
    } else {
      quietSince = null
      if (mid && !waited) {
        // Busy between two evals: pause, and from here wait for a full quiet window like a fresh start.
        job.notes = `paused ${new Date().toISOString().slice(0, 16)}Z: ${why.join('; ')}`
        writeJob(job)
      }
    }
    waited = true
    const said = why.join('; ')
    if (said !== lastSaid || Date.now() - lastAt > 10 * 60_000) {
      console.log(`[${stamp()}] waiting: ${said}`)
      lastSaid = said
      lastAt = Date.now()
    }
    await sleep(poll)
  }
}

async function runJob(start: Job, o: { poll: number; deadline: number }): Promise<'finished' | 'time' | 'gone'> {
  const job = start
  console.log(`\n##### ${job.id}: ${job.reason}`)
  const plan = await planFor(job)
  const kinds = onlyKinds(job)
  const all = evalsOf(plan, kinds)
  printPlan(plan)
  if (all.length === 0) {
    job.status = 'failed'
    job.notes = `nothing to run on this machine: ${plan.rows.map((r) => `${r.model.label}: ${r.skip}`).join('; ') || 'no model lists these suites'}`
    writeJob(job)
    return 'finished'
  }
  const todo = all.filter((e) => !job.done.includes(evalKey(e)))
  if (todo.length > 0) {
    job.status = 'running'
    writeJob(job)
  }
  const reread = (): Job => {
    const fresh = readJob(job.id)
    if (!fresh || fresh.status !== 'running') throw new Stop('gone')
    return fresh
  }
  let current = job
  try {
    const { failures } = await runPlan({
      plan,
      onlyKinds: kinds,
      repeat: job.repeat,
      skip: (e) => job.done.includes(evalKey(e)),
      before: async (_e: EvalId, index: number) => {
        // A person may have dropped the job, or edited its needs, since the last eval.
        if (index > 0) current = reread()
        const waited = await waitForMachine(current, index > 0, o.poll, o.deadline)
        if (waited) current.notes = ''
        return waited
      },
      after: (e, run) => {
        current = reread()
        current.done = [...new Set([...current.done, evalKey(e)])]
        current.run_ids = [...new Set([...current.run_ids, run])]
        writeJob(current)
      },
    })
    current = readJob(job.id) ?? current
    const left = all.filter((e) => !current.done.includes(evalKey(e)))
    current.status = left.length === 0 ? 'done' : 'failed'
    current.notes = failures.length > 0 ? `errors: ${failures.join('; ')}` : ''
    writeJob(current)
    if (current.status === 'done') console.log(`\nSummary: ${summarize()}`)
    else console.error(`\n${job.id} failed (set status: pending to retry the ${left.length} evals left):\n${failures.join('\n')}`)
    return 'finished'
  } catch (err) {
    if (!(err instanceof Stop)) throw err
    console.log(err.message === 'time' ? `\n--max-hours reached: ${job.id} stays running and resumes next time` : `\n${job.id} was dropped or changed; moving on`)
    return err.message === 'time' ? 'time' : 'gone'
  }
}

// ---- main ----------------------------------------------------------------------

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2)
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      models: { type: 'string' },
      suites: { type: 'string' },
      kinds: { type: 'string' },
      reason: { type: 'string' },
      priority: { type: 'string' },
      needs: { type: 'string' },
      repeat: { type: 'string' },
      once: { type: 'boolean' },
      watch: { type: 'boolean' },
      force: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      'max-hours': { type: 'string' },
      'poll-seconds': { type: 'string' },
    },
  })
  if (cmd === 'add') await add(values)
  else if (cmd === 'sync') await sync(values['dry-run'] === true)
  else if (cmd === 'list') await list()
  else if (cmd === 'drop') {
    const id = positionals[0]
    const job = id ? readJob(id) : null
    if (!job) throw new Error(`no job "${id ?? ''}" in queue/`)
    if (job.status === 'running' && !values.force) throw new Error(`${id} is running; --force to drop it anyway`)
    dropJob(job.id)
    console.log(`dropped ${job.id}`)
  } else if (cmd === 'work') await work(values)
  else {
    console.error('usage: bun scripts/queue.ts add|sync|list|drop <id>|work [--once] [--max-hours N] [--watch]')
    process.exit(2)
  }
}
