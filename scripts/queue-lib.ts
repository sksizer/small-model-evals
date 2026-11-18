// The run queue: work prepared ahead, run when the machine is free.
//
// One small YAML file per job in queue/ (committed). One file per job rather
// than one queue.yaml because jobs are added from different branches and
// machines (a merge of two added files never conflicts; two edits to one list
// do), the worker rewrites only the file of the job it is running, and a
// finished job's file reads as its own history. Human-editable: change a job's
// `priority`, `needs` or `status` in any editor; the worker re-reads the file
// before every eval.
//
//   id        file name without .yaml
//   created   ISO time
//   reason    why it was queued, a sentence
//   models    model labels (scripts/models.ts)
//   suites    suite ids
//   kinds     optional: only the cases of these kinds (a provider's `config.kinds`)
//   priority  whole number, higher runs first (default 0); ties go to the older job
//   needs     what must hold before it runs (below); absent keys are not checked
//   repeat    optional: run every case this many times (promptfoo --repeat); timing becomes a median with spread
//   status    pending | running | done | failed
//   run_ids   the runs (results/ledger `run`) that did its evals
//   done      the evals finished, `model·suite[·kind]`: the resume point after a kill
//   notes     free text; the worker writes why it paused, failed or finished
//
// needs: max_load_per_core (1-minute load per logical core), min_free_gib (memory available without swapping),
// max_swap_gib, quiet_minutes (everything above must hold continuously that long before the job starts),
// ac_power (not on battery), class (only this class of machine runs it, e.g. apple-16g), profile (machines/<name>.yaml).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Conditions } from './conditions.ts'
import type { EvalId } from './run-core.ts'
import { ROOT, currentSnapshot, type Latest } from './ledger.ts'
import { MODELS } from './models.ts'
import { suiteLabels } from './plan.ts'

export const QUEUE_DIR = join(ROOT, 'queue')
export const STATUSES = ['pending', 'running', 'done', 'failed'] as const
export type Status = (typeof STATUSES)[number]

export interface Needs {
  max_load_per_core?: number
  min_free_gib?: number
  max_swap_gib?: number
  quiet_minutes?: number
  ac_power?: boolean
  class?: string
  profile?: string
}

export interface Job {
  id: string
  created: string
  reason: string
  models: string[]
  suites: string[]
  kinds?: string[]
  priority: number
  needs: Needs
  repeat?: number
  status: Status
  run_ids: string[]
  done: string[]
  notes: string
}

const NEEDS_KEYS: Record<keyof Needs, 'number' | 'boolean' | 'string'> = {
  max_load_per_core: 'number',
  min_free_gib: 'number',
  max_swap_gib: 'number',
  quiet_minutes: 'number',
  ac_power: 'boolean',
  class: 'string',
  profile: 'string',
}

/** Short names for `--needs load=0.3,free=4,quiet=10,ac=true,class=apple-16g`. */
const NEEDS_ALIASES: Record<string, keyof Needs> = { load: 'max_load_per_core', free: 'min_free_gib', swap: 'max_swap_gib', quiet: 'quiet_minutes', ac: 'ac_power' }

export function parseNeeds(text: string | undefined): Needs {
  const needs: Record<string, number | boolean | string> = {}
  for (const part of (text ?? '').split(',').filter((p) => p.trim())) {
    const [rawKey, ...rest] = part.split('=')
    const raw = rest.join('=').trim()
    const key = (NEEDS_ALIASES[rawKey!.trim()] ?? rawKey!.trim()) as keyof Needs
    const kind = NEEDS_KEYS[key]
    if (!kind) throw new Error(`unknown need "${rawKey}" (have: ${[...Object.keys(NEEDS_ALIASES), ...Object.keys(NEEDS_KEYS)].join(', ')})`)
    if (kind === 'number') {
      if (!(Number(raw) >= 0)) throw new Error(`need ${key} wants a number, got "${raw}"`)
      needs[key] = Number(raw)
    } else if (kind === 'boolean') needs[key] = raw === 'true' || raw === '1' || raw === 'yes'
    else needs[key] = raw
  }
  return needs as Needs
}

// ---- files ---------------------------------------------------------------------

const jobPath = (id: string) => join(QUEUE_DIR, `${id}.yaml`)

/** Problems with one parsed job, in words; empty when it is sound. scripts/check.ts reports them. */
export function jobProblems(j: Partial<Job>, file: string): string[] {
  const out: string[] = []
  const bad = (m: string) => out.push(`queue/${file}: ${m}`)
  if (j.id !== file.replace(/\.yaml$/, '')) bad(`id "${j.id}" differs from the file name`)
  if (typeof j.created !== 'string' || Number.isNaN(Date.parse(j.created))) bad('created is not a date')
  if (typeof j.reason !== 'string' || !j.reason.trim()) bad('reason is empty')
  const known = new Set(MODELS.map((m) => m.label))
  if (!Array.isArray(j.models) || j.models.length === 0) bad('models is empty')
  for (const m of j.models ?? []) if (!known.has(m)) bad(`unknown model "${m}"`)
  if (!Array.isArray(j.suites) || j.suites.length === 0) bad('suites is empty')
  for (const s of j.suites ?? []) if (!existsSync(join(ROOT, 'suites', s))) bad(`unknown suite "${s}"`)
  if (!Number.isInteger(j.priority)) bad('priority is not a whole number')
  if (j.repeat !== undefined && !(Number.isInteger(j.repeat) && j.repeat >= 1)) bad('repeat is not a whole number of 1 or more')
  if (!STATUSES.includes(j.status as Status)) bad(`status "${j.status}" is not one of ${STATUSES.join(', ')}`)
  if (!Array.isArray(j.run_ids)) bad('run_ids is not a list')
  if (!Array.isArray(j.done)) bad('done is not a list')
  const needs = (j.needs ?? {}) as Record<string, unknown>
  for (const [k, v] of Object.entries(needs)) {
    const kind = NEEDS_KEYS[k as keyof Needs]
    if (!kind) bad(`unknown need "${k}"`)
    else if (typeof v !== kind) bad(`need ${k} should be a ${kind}`)
  }
  return out
}

/** The queue's jobs, oldest file first; a file that does not parse is reported by `jobProblems`, not thrown here. */
export function readJobs(): Job[] {
  if (!existsSync(QUEUE_DIR)) return []
  return readdirSync(QUEUE_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => ({ ...(Bun.YAML.parse(readFileSync(join(QUEUE_DIR, f), 'utf8')) as Job), id: f.replace(/\.yaml$/, '') }))
}

export const readJob = (id: string): Job | null => (existsSync(jobPath(id)) ? readJobs().find((j) => j.id === id) ?? null : null)

const FIELD_ORDER: (keyof Job)[] = ['id', 'created', 'reason', 'models', 'suites', 'kinds', 'priority', 'needs', 'repeat', 'status', 'run_ids', 'done', 'notes']

/** Writes a job atomically (temp file, then rename), so a kill never leaves half a file. */
export function writeJob(job: Job): void {
  mkdirSync(QUEUE_DIR, { recursive: true })
  const ordered = Object.fromEntries(FIELD_ORDER.filter((k) => job[k] !== undefined).map((k) => [k, job[k]]))
  const path = jobPath(job.id)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, Bun.YAML.stringify(ordered, null, 2).replace(/[ \t]+$/gm, '').replace(/^(\w+):\n {2}\[\]$/gm, '$1: []') + '\n')
  renameSync(tmp, path)
}

export function dropJob(id: string): void {
  unlinkSync(jobPath(id))
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '')

/** A new id: the date and a slug of the reason, with a number when that is taken. */
export function newId(reason: string, now = new Date()): string {
  const base = `${now.toISOString().slice(0, 10).replace(/-/g, '')}-${slug(reason) || 'job'}`
  let id = base
  for (let n = 2; existsSync(jobPath(id)); n++) id = `${base}-${n}`
  return id
}

export function makeJob(fields: Pick<Job, 'reason' | 'models' | 'suites'> & Partial<Job>, now = new Date()): Job {
  return {
    id: newId(fields.reason, now),
    created: now.toISOString().replace(/\.\d+Z$/, 'Z'),
    priority: 0,
    needs: {},
    status: 'pending',
    run_ids: [],
    done: [],
    notes: '',
    ...fields,
  }
}

// ---- conditions ------------------------------------------------------------------

/**
 * What of a job's `needs` does this sample not meet, in words; empty when it holds.
 * `mid` is for a check between two evals of a running job: the load average then is
 * mostly the eval's own work, so it is not held against the job; another heavy program
 * is (whenever the job asks for any load limit).
 */
export function unmet(c: Conditions, n: Needs, mid = false): string[] {
  const out: string[] = []
  if (n.max_load_per_core !== undefined) {
    if (!mid && c.load_per_core > n.max_load_per_core) out.push(`load ${c.load_per_core}/core is over ${n.max_load_per_core}`)
    for (const b of c.busy) out.push(`${b.name} is using ${b.cpu_pct}% of a core`)
  }
  if (n.min_free_gib !== undefined && c.mem_available_gib < n.min_free_gib) out.push(`${c.mem_available_gib} GiB free, needs ${n.min_free_gib}`)
  if (n.max_swap_gib !== undefined && c.swap_used_gib > n.max_swap_gib) out.push(`${c.swap_used_gib} GiB of swap in use, limit ${n.max_swap_gib}`)
  if (n.ac_power && c.power === 'battery') out.push('on battery')
  return out
}

// ---- how long ---------------------------------------------------------------------

const median = (xs: number[]): number | null => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b)
  return s.length === 0 ? null : s[Math.floor((s.length - 1) / 2)]!
}

/** Fixed cost of an eval besides its cases: promptfoo starting, the model unloading and loading again. */
export const EVAL_OVERHEAD_MS = 30_000
const DEFAULT_CASE_MS = 10_000

/** The evals a job covers, ignoring fit (models a suite does not list are left out); the worker's own list comes from a plan. */
export async function jobEvals(job: Pick<Job, 'models' | 'suites' | 'kinds'>): Promise<EvalId[]> {
  const out: EvalId[] = []
  for (const model of job.models) {
    for (const suite of job.suites) {
      const labels = await suiteLabels(suite)
      if (!labels.has(model)) continue
      for (const kind of (labels.get(model) ?? [null]).filter((k) => !job.kinds || (k !== null && job.kinds.includes(k)))) out.push({ model, suite, kind })
    }
  }
  return out
}

/** How many cases an eval runs: the suite's active cases, of its kind when it has one. */
function caseCount(e: EvalId): number {
  const cases = Object.values(currentSnapshot(e.suite).cases)
  return e.kind ? cases.filter((c) => (c.def['metadata'] as { kind?: string } | undefined)?.kind === e.kind).length : cases.length
}

/**
 * Milliseconds the evals will take, from what the ledger shows each model taking per case on this machine
 * (median case latency of its newest results on the suite; else the model on any suite; else the suite for any
 * model; else a guess), plus a fixed cost per eval. `guessed` counts the evals that fell back to a guess.
 */
export function estimate(evals: EvalId[], repeat: number, view: Latest[], machineKey?: string): { ms: number; guessed: number } {
  const latencies = (pred: (v: Latest) => boolean) => median(view.filter(pred).flatMap((v) => v.records.map((r) => r.latency_ms)))
  let ms = 0
  let guessed = 0
  for (const e of evals) {
    const mine = (v: Latest) => machineKey === undefined || v.machine === machineKey
    const per =
      latencies((v) => mine(v) && v.model === e.model && v.suite === e.suite) ??
      latencies((v) => v.model === e.model && v.suite === e.suite) ??
      latencies((v) => mine(v) && v.model === e.model) ??
      latencies((v) => mine(v) && v.suite === e.suite) ??
      null
    if (per === null) guessed++
    ms += EVAL_OVERHEAD_MS + caseCount(e) * repeat * (per ?? DEFAULT_CASE_MS)
  }
  return { ms, guessed }
}

export const hours = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)}s` : ms < 90 * 60_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`)

/** Whether a job is still waiting for compute. */
export const open = (j: Job) => j.status === 'pending' || j.status === 'running'

/** Jobs in the order the worker takes them: running first (resume), then by priority, then oldest. */
export const byTurn = (a: Job, b: Job) => Number(b.status === 'running') - Number(a.status === 'running') || b.priority - a.priority || a.created.localeCompare(b.created) || a.id.localeCompare(b.id)
