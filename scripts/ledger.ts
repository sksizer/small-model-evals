// The results ledger and the records it links to.
//
// Three things are immutable once written, so every result can be traced to
// exactly what produced it:
//
// - A case: suites/<suite>/cases/<id>.yaml. Once a snapshot names it, its
//   content never changes. To evolve a case, add a new one with a new id and
//   `metadata.supersedes`, and move the old file to cases/retired/.
// - A suite snapshot: results/suites/<suite>/<fingerprint>.json, written the
//   first time a run uses that version of the suite. It freezes the setup
//   (config without its test list, referenced files, scoring code) and every
//   active case with its content and hash.
// - A ledger record: one JSON line per scored case in
//   results/ledger/<suite>.jsonl. Lines are only ever appended. Each names
//   its snapshot by `suite_fp`.
//
// Each record also names its environment (results/environments/) and model
// build (results/models/<digest>.json); see scripts/env.ts.
//
// scripts/check.ts enforces all of it.
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { spawnRunner } from '@osdlc/command-seam'

export const ROOT = join(import.meta.dir, '..')
/**
 * `EVALS_SCOPE=private` runs the suites under private/ (gitignored) and keeps
 * their snapshots, ledger and raw output under private/results/, for cases
 * built from your own notes or photos. Environments and model builds stay
 * shared: they describe the machine and the model, not the data.
 */
export const SCOPE: 'public' | 'private' = process.env['EVALS_SCOPE'] === 'private' ? 'private' : 'public'
const SCOPE_ROOT = SCOPE === 'private' ? join(ROOT, 'private') : ROOT
export const SUITES_DIR = join(SCOPE_ROOT, 'suites')
export const RESULTS_DIR = join(SCOPE_ROOT, 'results')
export const LEDGER_DIR = join(RESULTS_DIR, 'ledger')
export const SNAPSHOT_DIR = join(RESULTS_DIR, 'suites')
export const OLLAMA = process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434'
export const PROMPTFOO_VERSION = '0.125.1'

/** Folders of shared code that scores or calls suites. Every file is hashed into each snapshot; a result depends only on the ones its suite and its model's provider use (scorerFilesOf). */
const SCORER_DIRS = ['assertions', 'providers']

export interface Machine {
  /** Hardware model and memory, e.g. `Mac16,10-16g`. Groups results; names no person or host. */
  key: string
  chip: string
  hw_model: string
  mem_gib: number
}

export interface LedgerRecord {
  run: string
  at: string
  machine: Machine
  ollama: string
  promptfoo: string
  model: { label: string; tag: string; digest: string }
  suite: string
  /** The snapshot this ran against: results/suites/<suite>/<suite_fp>.json. */
  suite_fp: string
  /** What it ran on: results/environments/<env>.json. Absent on records made before it existed. */
  env?: string
  case: string
  /** 0-based, for suites that repeat a case (perf). */
  repeat: number
  pass: boolean
  score: number
  latency_ms: number
  tokens?: { prompt?: number | undefined; completion?: number | undefined }
  reason?: string
  error?: string
  /** The model's whole reply. */
  output?: string
  /** Speed and memory, from the perf provider. */
  metrics?: Record<string, number>
  /** What the scorer recorded beyond a score and reason (the edit suite's judge answers), from the assertion's `metadata`. */
  detail?: unknown
}

export function machine(): Machine {
  const run = spawnRunner('sysctl')
  const get = (name: string) => run.run(['-n', name], { cwd: ROOT }).stdout.trim()
  const memGib = Math.round(Number(get('hw.memsize')) / 2 ** 30)
  const hwModel = get('hw.model')
  return { key: `${hwModel}-${memGib}g`, chip: get('machdep.cpu.brand_string'), hw_model: hwModel, mem_gib: memGib }
}

export async function ollamaVersion(): Promise<string> {
  const { version } = (await (await fetch(`${OLLAMA}/api/version`)).json()) as { version: string }
  return version
}

/** Installed model tag to the first 12 hex of its digest: the exact build that ran. */
export async function modelDigests(): Promise<Map<string, string>> {
  const { models } = (await (await fetch(`${OLLAMA}/api/tags`)).json()) as { models: { name: string; digest: string }[] }
  return new Map(models.map((m) => [m.name, m.digest.slice(0, 12)]))
}

// ---- hashing -------------------------------------------------------------------

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')
const short = (s: string) => s.slice(0, 12)

const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]))
      : v

const readYaml = (path: string) => Bun.YAML.parse(readFileSync(path, 'utf8')) as unknown

/**
 * A value with every `file://` reference replaced by what the file holds:
 * YAML and JSON inlined (parsed, so comments and layout do not count), other
 * files as `sha256:<hash>`. Paths resolve against the suite folder, as
 * promptfoo resolves them, and drop out of the result, so moving a file
 * without changing it changes nothing.
 */
function inlineRefs(v: unknown, base: string): unknown {
  if (typeof v === 'string' && v.startsWith('file://')) {
    const path = resolve(base, v.slice('file://'.length))
    if (!existsSync(path)) return `missing:${v}`
    const ext = extname(path)
    if (ext === '.yaml' || ext === '.yml') return inlineRefs(readYaml(path), base)
    if (ext === '.json') return JSON.parse(readFileSync(path, 'utf8')) as unknown
    return `sha256:${sha(readFileSync(path))}`
  }
  if (Array.isArray(v)) return v.map((x) => inlineRefs(x, base))
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, inlineRefs(x, base)]))
  }
  return v
}

// ---- cases ---------------------------------------------------------------------

export interface CaseFile {
  id: string
  suite: string
  path: string
  retired: boolean
  /** The case as written. */
  def: Record<string, unknown>
  /** Hash of the case with its referenced files inlined. */
  hash: string
}

/** Every case of a suite: the active ones in cases/, then the retired ones. */
export function loadCases(suite: string): CaseFile[] {
  const dir = join(SUITES_DIR, suite)
  const read = (folder: string, retired: boolean) => {
    const path = join(dir, folder)
    if (!existsSync(path)) return []
    return readdirSync(path)
      .filter((f) => f.endsWith('.yaml'))
      .sort()
      .map((f) => {
        const file = join(path, f)
        const def = readYaml(file) as Record<string, unknown>
        const id = (def['metadata'] as { id?: string } | undefined)?.id
        if (id !== basename(f, '.yaml')) throw new Error(`${file}: metadata.id must equal the file name (got ${id})`)
        return { id, suite, path: file, retired, def, hash: short(sha(JSON.stringify(canonical(inlineRefs(def, dir))))) }
      })
  }
  return [...read('cases', false), ...read(join('cases', 'retired'), true)]
}

// ---- snapshots -----------------------------------------------------------------

export interface Snapshot {
  suite: string
  fingerprint: string
  setup_hash: string
  /** The config without its test list, with referenced files inlined. */
  setup: unknown
  /** Hash of each scoring file. */
  scorers: Record<string, string>
  /** Every active case when the snapshot was taken. */
  cases: Record<string, { hash: string; def: Record<string, unknown> }>
  /**
   * Set on snapshots written for records made before snapshots existed: the
   * file is named by the old fingerprint, and its content is the suite as it
   * stood unchanged when they were saved.
   */
  legacy?: string
}

function setupOf(suite: string): Pick<Snapshot, 'setup' | 'scorers' | 'setup_hash'> {
  const dir = join(SUITES_DIR, suite)
  const { tests: _tests, ...config } = readYaml(join(dir, 'promptfooconfig.yaml')) as Record<string, unknown>
  const setup = canonical(inlineRefs(config, dir))
  const scorers = Object.fromEntries(
    SCORER_DIRS.flatMap((d) => readdirSync(join(ROOT, d)).sort().map((f) => [`${d}/${f}`, short(sha(readFileSync(join(ROOT, d, f))))])),
  )
  return { setup, scorers, setup_hash: short(sha(JSON.stringify({ setup, scorers }))) }
}

/** The fingerprint of a setup and a set of cases. */
const fingerprintOf = (setupHash: string, cases: Record<string, { hash: string }>) =>
  short(sha([setupHash, ...Object.keys(cases).sort().map((id) => `${id}:${cases[id]!.hash}`)].join('\n')))

/** The suite as it stands now, ready to freeze. */
export function currentSnapshot(suite: string): Snapshot {
  const setup = setupOf(suite)
  const cases = Object.fromEntries(loadCases(suite).filter((c) => !c.retired).map((c) => [c.id, { hash: c.hash, def: c.def }]))
  return { suite, fingerprint: fingerprintOf(setup.setup_hash, cases), ...setup, cases }
}

const snapshotPath = (suite: string, fp: string) => join(SNAPSHOT_DIR, suite, `${fp}.json`)

/**
 * Freezes the suite as it stands and returns its fingerprint. Writes the
 * snapshot the first time; after that the file must match, or a case or the
 * setup changed without a new fingerprint, which cannot happen unless the
 * file was edited.
 */
export function freeze(suite: string): string {
  const snap = currentSnapshot(suite)
  const path = snapshotPath(suite, snap.fingerprint)
  const text = `${JSON.stringify(snap, null, 2)}\n`
  if (!existsSync(path)) {
    mkdirSync(join(SNAPSHOT_DIR, suite), { recursive: true })
    writeFileSync(path, text)
  } else if (readFileSync(path, 'utf8') !== text) {
    throw new Error(`${path} differs from the suite it names; snapshots are immutable`)
  }
  return snap.fingerprint
}

const snapshots = new Map<string, Snapshot | null>()
export function readSnapshot(suite: string, fp: string): Snapshot | null {
  const key = `${suite}/${fp}`
  if (!snapshots.has(key)) {
    const path = snapshotPath(suite, fp)
    snapshots.set(key, existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Snapshot) : null)
  }
  return snapshots.get(key)!
}

export function listSnapshots(): Snapshot[] {
  if (!existsSync(SNAPSHOT_DIR)) return []
  return readdirSync(SNAPSHOT_DIR).flatMap((suite) =>
    readdirSync(join(SNAPSHOT_DIR, suite))
      .filter((f) => f.endsWith('.json'))
      .map((f) => readSnapshot(suite, basename(f, '.json'))!),
  )
}

/** Checks a snapshot's name against its content. */
export function snapshotIntegrity(snap: Snapshot): string | null {
  const recomputed = fingerprintOf(snap.setup_hash, snap.cases)
  if (snap.legacy) return snap.legacy === recomputed ? null : `legacy snapshot ${snap.fingerprint} no longer recomputes to ${snap.legacy}`
  return recomputed === snap.fingerprint ? null : `snapshot ${snap.fingerprint} recomputes to ${recomputed}`
}

// ---- promptfoo output to records ---------------------------------------------

interface PromptfooRow {
  success: boolean
  score: number
  latencyMs: number
  error?: string
  failureReason?: number
  testCase: { description?: string; metadata?: { id?: string } }
  response?: { output?: unknown; tokenUsage?: { prompt?: number; completion?: number }; metadata?: Record<string, unknown> }
  gradingResult?: { reason?: string; metadata?: Record<string, unknown>; componentResults?: { metadata?: Record<string, unknown> }[] }
}

/** promptfoo's ResultFailureReason for a call that errored, as against an assertion that failed. */
const CALL_ERROR = 2

export interface RunContext {
  run: string
  at: string
  machine: Machine
  ollama: string
  promptfoo: string
  model: { label: string; tag: string; digest: string }
  suite: string
  suite_fp: string
  env?: string
}

/** The scorer's `metadata`, from the grading itself or, for one assertion, its component. */
const detailOf = (r: PromptfooRow): Record<string, unknown> | undefined => {
  const g = r.gradingResult
  const m = g?.metadata && Object.keys(g.metadata).length > 0 ? g.metadata : g?.componentResults?.find((c) => c.metadata && Object.keys(c.metadata).length > 0)?.metadata
  return m
}

export function recordsFromPromptfoo(file: string, ctx: RunContext): LedgerRecord[] {
  const rows = (JSON.parse(readFileSync(file, 'utf8')) as { results: { results: PromptfooRow[] } }).results.results
  const repeats = new Map<string, number>()
  return rows.map((r) => {
    const id = r.testCase.metadata?.id
    if (!id) throw new Error(`${file}: a case has no metadata.id (${r.testCase.description ?? 'no description'})`)
    const repeat = repeats.get(id) ?? 0
    repeats.set(id, repeat + 1)
    const output = r.response?.output
    const metrics = Object.fromEntries(
      Object.entries(r.response?.metadata ?? {}).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)),
    ) as Record<string, number>
    return {
      ...ctx,
      case: id,
      repeat,
      pass: r.success,
      score: r.score,
      latency_ms: Math.round(r.latencyMs),
      ...(r.response?.tokenUsage ? { tokens: { prompt: r.response.tokenUsage.prompt, completion: r.response.tokenUsage.completion } } : {}),
      ...(r.gradingResult?.reason ? { reason: r.gradingResult.reason } : {}),
      ...(r.failureReason === CALL_ERROR && r.error ? { error: r.error } : {}),
      ...(detailOf(r) ? { detail: detailOf(r) } : {}),
      ...(output === undefined ? {} : { output: typeof output === 'string' ? output : JSON.stringify(output) }),
      ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
    }
  })
}

export function append(records: LedgerRecord[]): void {
  mkdirSync(LEDGER_DIR, { recursive: true })
  const bySuite = new Map<string, LedgerRecord[]>()
  for (const r of records) bySuite.set(r.suite, [...(bySuite.get(r.suite) ?? []), r])
  for (const [suite, rs] of bySuite) {
    appendFileSync(join(LEDGER_DIR, `${suite}.jsonl`), rs.map((r) => `${JSON.stringify(r)}\n`).join(''))
  }
}

// ---- reading -----------------------------------------------------------------

export function readLedger(): LedgerRecord[] {
  if (!existsSync(LEDGER_DIR)) return []
  return readdirSync(LEDGER_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) =>
      readFileSync(join(LEDGER_DIR, f), 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as LedgerRecord),
    )
}

export interface Latest {
  machine: string
  model: string
  suite: string
  /** The newest run among `records`. */
  run: string
  /** Some records ran against an older setup or case version; rerun to refresh. */
  stale: boolean
  /** Active cases this model has never run on this machine. */
  missing: string[]
  /** Per active case, the newest run's records (all repeats). */
  records: LedgerRecord[]
}

/**
 * The scorer files a suite uses, by path from the package root: its config's
 * `file://` references into the scorer folders and, transitively, the local
 * files they import. Given a model label, only that model's own provider
 * entry counts, not the other models' providers: a change to one provider's
 * code leaves the other models' results current.
 */
export function scorerFilesOf(suite: string, label?: string): string[] {
  const dir = join(SUITES_DIR, suite)
  const found = new Set<string>()
  const visit = (path: string) => {
    const name = relative(ROOT, path)
    if (found.has(name) || !existsSync(path) || !SCORER_DIRS.some((d) => name.startsWith(`${d}/`))) return
    found.add(name)
    for (const m of readFileSync(path, 'utf8').matchAll(/from\s+'(\.{1,2}\/[^']+)'/g)) visit(resolve(dirname(path), m[1]!))
  }
  const walk = (v: unknown): void => {
    if (typeof v === 'string' && v.startsWith('file://')) visit(resolve(dir, v.slice('file://'.length)))
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  const config = readYaml(join(dir, 'promptfooconfig.yaml')) as { providers?: { label?: string }[] }
  if (label === undefined) walk(config)
  else {
    const { providers, ...shared } = config
    walk(shared)
    walk(providers?.find((p) => p.label === label) ?? null)
  }
  return [...found].sort()
}

/**
 * What one model's results in a snapshot depend on: the suite setup other
 * than the provider list, that model's own provider entry, and the scorer
 * files the suite uses (`files`, from scorerFilesOf). Adding a model, or an
 * unrelated scorer, leaves other models' results current.
 */
export function resultKey(snap: Snapshot, label: string, files: string[]): string {
  const { providers, ...shared } = snap.setup as { providers?: { label?: string }[] }
  const provider = providers?.find((p) => p.label === label) ?? null
  return short(sha(JSON.stringify({ shared, provider, scorers: files.map((f) => [f, snap.scorers[f] ?? null]) })))
}

/**
 * Per machine, model and suite: for each active case, the newest records,
 * preferring ones whose result key (resultKey) and case content match the
 * suite as it stands.
 */
export function latest(records = readLedger()): Latest[] {
  const current = new Map<string, Snapshot | null>()
  const now = (suite: string) => {
    if (!current.has(suite)) current.set(suite, existsSync(join(SUITES_DIR, suite)) ? currentSnapshot(suite) : null)
    return current.get(suite)!
  }
  const filesFor = new Map<string, string[]>()
  const files = (suite: string, label: string) => {
    const key = `${suite}\u0000${label}`
    if (!filesFor.has(key)) filesFor.set(key, scorerFilesOf(suite, label))
    return filesFor.get(key)!
  }
  const isCurrent = (r: LedgerRecord) => {
    const cur = now(r.suite)
    const snap = readSnapshot(r.suite, r.suite_fp)
    if (!cur || !snap || snap.cases[r.case]?.hash !== cur.cases[r.case]?.hash) return false
    const f = files(r.suite, r.model.label)
    return resultKey(snap, r.model.label, f) === resultKey(cur, r.model.label, f)
  }
  const groups = new Map<string, LedgerRecord[]>()
  for (const r of records) {
    const key = [r.machine.key, r.model.label, r.suite].join('\u0000')
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  return [...groups.values()].map((rs) => {
    const first = rs[0]!
    const active = Object.keys(now(first.suite)?.cases ?? {})
    const chosen: LedgerRecord[] = []
    const missing: string[] = []
    let stale = false
    for (const id of active) {
      const forCase = rs.filter((r) => r.case === id)
      if (forCase.length === 0) {
        missing.push(id)
        continue
      }
      const fresh = forCase.filter(isCurrent)
      const pool = fresh.length > 0 ? fresh : forCase
      if (fresh.length === 0) stale = true
      const run = pool.map((r) => r.run).sort().at(-1)!
      chosen.push(...pool.filter((r) => r.run === run))
    }
    return {
      machine: first.machine.key,
      model: first.model.label,
      suite: first.suite,
      run: chosen.map((r) => r.run).sort().at(-1) ?? '',
      stale,
      missing,
      records: chosen,
    }
  })
}
