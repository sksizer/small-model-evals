// Writes the results site's data: the ledger's latest view, each case's input
// and expected value, per-run history and speed rows, as one evals.json, plus
// every image the site shows. The site reads only these, so it builds without
// Ollama or Bun APIs.
//
//   bun scripts/export-site.ts                      → site/src/data, site/public
//   EVALS_SCOPE=private bun scripts/export-site.ts  → private/site/data, private/site/public
//
// The public site is published, so a private export never writes under site/;
// it goes under private/ (gitignored). scripts/build-site.ts builds either.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { matches, parseJson, type Expected } from '../assertions/match.ts'
import { conceptLabel, parseTags, tagMatches, type Concept } from '../assertions/tags.ts'
import { compareWorkout, type ExpectedWorkout } from '../assertions/workout.ts'
import { compareFood, type ExpectedFood } from '../assertions/food.ts'
import { compareDecide } from '../assertions/decide.ts'
import { compareRegions, type ExpectedRegions } from '../assertions/regions.ts'
import { parseEdit, type EditGrading, type ExpectedEdit } from '../assertions/edit.ts'
import { ENV_DIR, MODEL_DIR } from './env.ts'
import type { CorpusImage } from './fetch-corpus.ts'
import { MODELS, ageMonths, skipReason } from './models.ts'
import { ROOT, SCOPE, SUITES_DIR, currentSnapshot, latest, loadCases, readLedger, readSnapshot, type LedgerRecord } from './ledger.ts'

interface CaseDef {
  description?: string
  metadata?: { id?: string; supersedes?: string; retired?: string }
  vars?: Record<string, unknown>
}

/** The vars that a person reads as the case's input, by suite. */
const INPUT_VARS = ['note', 'log', 'request', 'item', 'image', 'input']


function inputOf(suite: string, vars: Record<string, unknown> = {}): { text: string; image?: string } {
  for (const key of INPUT_VARS) {
    const v = vars[key]
    if (typeof v !== 'string') continue
    if (key === 'image') {
      // `file://` vars resolve against the suite folder, as promptfoo does.
      const path = relative(ROOT, resolve(SUITES_DIR, suite, v.replace(/^file:\/\//, '')))
      // An edit case reads as its instruction, with the image beside it.
      const instruction = vars['instruction']
      return { text: typeof instruction === 'string' ? instruction : path, image: path }
    }
    if (v.startsWith('file://')) return { text: v.slice('file://'.length) }
    return { text: v }
  }
  const ctx = vars['num_ctx']
  return { text: ctx === undefined ? '' : `num_ctx ${ctx}` }
}

/**
 * A per-item comparison for the site's visual views: for a list of expected
 * strings (OCR text, tags), which ones the reply contains; for expected
 * fields (extraction), what the model returned for each. Uses the scorers'
 * own matcher, so the view agrees with the score.
 */
function compare(expected: unknown, absent: unknown, output: string, detail?: unknown) {
  // Edits: the judge's answers and the preservation number, as the scorer recorded them, and the edited image.
  if (isEdit(expected)) {
    const d = detail as EditGrading['metadata'] | undefined
    return { edit: { image: parseEdit(output), judge: d?.judge ?? null, answers: d?.answers ?? [], preservation: d?.preservation ?? null } }
  }
  // Tags: concepts with synonyms, matched against the reply's tag list.
  const tags = Array.isArray(absent) ? parseTags(output) : null
  if (Array.isArray(expected) && Array.isArray(absent)) {
    const got = tags ?? []
    return {
      hits: (expected as Concept[]).map((c) => ({ want: conceptLabel(c), found: tagMatches(c, got) })),
      wrong: (absent as string[]).map((want) => ({ want, found: tagMatches(want, got) })),
      tags,
    }
  }
  if (Array.isArray(expected) && expected.every((e) => typeof e === 'string')) {
    const text = output.toLowerCase()
    return { hits: (expected as string[]).map((want) => ({ want, found: text.includes(want.toLowerCase()) })) }
  }
  // Regions: expected and predicted boxes, paired, from the scorer.
  if (expected && typeof expected === 'object' && Array.isArray((expected as { boxes?: unknown }).boxes)) {
    const e = expected as ExpectedRegions
    return { regions: compareRegions(e.boxes, output, e.labels) }
  }
  // Decisions: one row per question, from the scorer.
  const decided = compareDecide(expected as Record<string, string | string[]>, output)
  if (decided && expected && typeof expected === 'object' && !Array.isArray(expected)) return { fields: decided }
  // Food lookups: one row per expected food and per extra item, from the scorer.
  if (Array.isArray(expected) && expected.length > 0 && expected.every((e) => e && typeof e === 'object' && 'text' in e)) {
    const rows = compareFood(expected as ExpectedFood[], output)
    return { fields: rows ? rows.map(({ field, want, got, ok }) => ({ field, want, got, ok })) : null }
  }
  // Workouts: one row per session field and per exercise, from the scorer.
  if (expected && typeof expected === 'object' && Array.isArray((expected as { exercises?: unknown }).exercises)) {
    const rows = compareWorkout(expected as ExpectedWorkout, output)
    return { fields: rows ? rows.map(({ field, want, got, ok }) => ({ field, want, got, ok })) : null }
  }
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    const got = parseJson(output)
    if (!got || typeof got !== 'object' || Array.isArray(got)) return { fields: null }
    return {
      fields: Object.entries(expected as Record<string, Expected>).map(([field, want]) => ({
        field,
        want,
        got: (got as Record<string, unknown>)[field] ?? null,
        ok: matches(want, (got as Record<string, unknown>)[field]),
      })),
    }
  }
  return {}
}

const isEdit = (e: unknown): e is ExpectedEdit =>
  !!e && typeof e === 'object' && Array.isArray((e as { changed?: unknown }).changed) && Array.isArray((e as { kept?: unknown }).kept)

/** What the site shows of a case, from its definition as written. */
function caseView(suite: string, id: string, raw: Record<string, unknown>, hash: string) {
  const c = raw as CaseDef
  return {
    id,
    hash,
    description: c.description ?? '',
    input: inputOf(suite, c.vars),
    expected: c.vars?.['expected'] ?? c.vars?.['tool'] ?? null,
    absent: c.vars?.['absent'] ?? null,
    instruction: typeof c.vars?.['instruction'] === 'string' ? c.vars['instruction'] : null,
    args: c.vars?.['args'] ?? null,
    supersedes: c.metadata?.supersedes ?? null,
    retired: c.metadata?.retired ?? null,
  }
}

const median = (xs: number[]): number | null => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b)
  return s.length === 0 ? null : s[Math.floor((s.length - 1) / 2)]!
}
const metric = (r: LedgerRecord, key: string) => r.metrics?.[key] ?? Number.NaN
// Below this Ollama reused the loaded model, so the prompt was cached.
const RELOAD_MS = 50

// Where this scope's site data goes. Private data never lands under site/.
const SITE_OUT = SCOPE === 'private' ? join(ROOT, 'private', 'site') : join(ROOT, 'site')
const DATA_OUT = SCOPE === 'private' ? join(SITE_OUT, 'data') : join(SITE_OUT, 'src', 'data')
const PUBLIC_OUT = join(SITE_OUT, 'public')
// The corpus, as a path from the repo root (case images are named that way).
const CORPUS_REL = SCOPE === 'private' ? 'private/corpus' : 'corpus'

const records = readLedger()
const view = latest(records)
const suites = readdirSync(SUITES_DIR).sort()

const suiteData = suites.map((suite) => {
  const snap = currentSnapshot(suite)
  const files = loadCases(suite)
  return {
    id: suite,
    kind: suite.startsWith('perf') ? 'perf' : 'quality',
    fingerprint: snap.fingerprint,
    cases: files.filter((c) => !c.retired).map((c) => caseView(c.suite, c.id, c.def, c.hash)),
    retired: files.filter((c) => c.retired).map((c) => caseView(c.suite, c.id, c.def, c.hash)),
  }
})

/** The case a record actually ran: from its frozen snapshot, not the current file. */
function ranCase(r: LedgerRecord) {
  const frozen = readSnapshot(r.suite, r.suite_fp)?.cases[r.case]
  return frozen ? caseView(r.suite, r.case, frozen.def, frozen.hash) : null
}

const cells = view
  .filter((v) => !v.suite.startsWith('perf'))
  .map((v) => ({
    machine: v.machine,
    model: v.model,
    suite: v.suite,
    run: v.run,
    stale: v.stale,
    passed: v.records.filter((r) => r.pass).length,
    total: v.records.length,
    missing: v.missing,
    mean: v.records.reduce((s, r) => s + r.score, 0) / v.records.length,
    median_ms: median(v.records.map((r) => r.latency_ms)),
  }))

const perf = view
  .filter((v) => v.suite.startsWith('perf'))
  .flatMap((v) => {
    const byCase = new Map<string, LedgerRecord[]>()
    for (const r of v.records) byCase.set(r.case, [...(byCase.get(r.case) ?? []), r])
    return [...byCase].map(([id, rs]) => {
      const cold = rs.reduce((a, b) => (metric(b, 'load_ms') > metric(a, 'load_ms') ? b : a))
      const loaded = median(rs.map((r) => metric(r, 'loaded_bytes')))
      const vram = median(rs.map((r) => metric(r, 'vram_bytes')))
      return {
        machine: v.machine,
        model: v.model,
        suite: v.suite,
        case: id,
        run: v.run,
        stale: v.stale,
        load_s: Number.isFinite(metric(cold, 'load_ms')) ? metric(cold, 'load_ms') / 1000 : null,
        prompt_tps: metric(cold, 'load_ms') < RELOAD_MS ? null : (median([metric(cold, 'prompt_tps')]) ?? null),
        prompt_cached: metric(cold, 'load_ms') < RELOAD_MS,
        decode_tps: median(rs.map((r) => metric(r, 'decode_tps'))),
        embeds_per_s: median(rs.map((r) => metric(r, 'embeds_per_s'))),
        loaded_gb: loaded === null ? null : loaded / 1e9,
        gpu_pct: loaded && vram !== null ? (100 * vram) / loaded : null,
      }
    })
  })

const results = view
  .filter((v) => !v.suite.startsWith('perf'))
  .flatMap((v) =>
    v.records.map((r) => {
      const c = ranCase(r)
      return {
        machine: v.machine,
        model: r.model.label,
        suite: r.suite,
        case: r.case,
        description: c?.description ?? '',
        input: c?.input.text ?? '',
        image: c?.input.image ?? null,
        expected: c?.expected ?? null,
        args: c?.args ?? null,
        pass: r.pass,
        score: r.score,
        latency_ms: r.latency_ms,
        reason: r.reason ?? '',
        error: r.error ?? '',
        output: r.output ?? '',
        run: r.run,
        stale: v.stale,
        suite_fp: r.suite_fp,
        case_hash: c?.hash ?? null,
        env: r.env ?? null,
        metrics: r.metrics ?? null,
        instruction: c?.instruction ?? null,
        ...compare(c?.expected, c?.absent, r.output ?? '', r.detail),
      }
    }),
  )

// Pass rate per run, for each machine, model and suite: the trend over time.
const historyKey = (r: LedgerRecord) => [r.machine.key, r.model.label, r.suite, r.run].join('\u0000')
const historyGroups = new Map<string, LedgerRecord[]>()
for (const r of records.filter((r) => !r.suite.startsWith('perf'))) {
  historyGroups.set(historyKey(r), [...(historyGroups.get(historyKey(r)) ?? []), r])
}
const history = [...historyGroups.values()].map((rs) => ({
  machine: rs[0]!.machine.key,
  model: rs[0]!.model.label,
  suite: rs[0]!.suite,
  run: rs[0]!.run,
  suite_fp: rs[0]!.suite_fp,
  passed: rs.filter((r) => r.pass).length,
  total: rs.length,
}))

const runMap = new Map<string, LedgerRecord[]>()
for (const r of records) runMap.set(r.run, [...(runMap.get(r.run) ?? []), r])
const runs = [...runMap]
  .sort(([a], [b]) => b.localeCompare(a))
  .map(([run, rs]) => ({
    run,
    at: rs.map((r) => r.at).sort()[0]!,
    machine: rs[0]!.machine.key,
    ollama: rs[0]!.ollama,
    promptfoo: rs[0]!.promptfoo,
    envs: [...new Set(rs.map((r) => r.env).filter((e): e is string => !!e))],
    models: [...new Set(rs.map((r) => r.model.label))].sort(),
    suites: [...new Set(rs.map((r) => r.suite))].sort(),
    records: rs.length,
  }))

const machines = [...new Map(records.map((r) => [r.machine.key, r.machine])).values()]
const models = [...new Map(records.map((r) => [r.model.label, r.model])).values()]
  .sort((a, b) => a.label.localeCompare(b.label))
  .map((m) => {
    const entry = MODELS.find((e) => e.label === m.label)
    return {
      ...m,
      released: entry?.released ?? null,
      released_approx: entry?.approx ?? false,
      age_months: entry ? ageMonths(entry.released) : null,
      baseline: entry?.baseline ?? null,
      retired: entry ? skipReason(entry) : 'no longer in scripts/models.ts',
    }
  })

// The image corpus for the corpus browser: each image with the cases that
// use it.
const manifestPath = join(ROOT, CORPUS_REL, 'manifest.json')
const usedBy = new Map<string, { suite: string; case: string; retired: boolean }[]>()
for (const s of suiteData) {
  for (const c of [...s.cases.map((x) => ({ ...x, isRetired: false })), ...s.retired.map((x) => ({ ...x, isRetired: true }))]) {
    if (!c.input.image) continue
    usedBy.set(c.input.image, [...(usedBy.get(c.input.image) ?? []), { suite: s.id, case: c.id, retired: c.isRetired }])
  }
}
const corpus = existsSync(manifestPath)
  ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as CorpusImage[]).map((m) => ({
      ...m,
      path: `${CORPUS_REL}/${m.file}`,
      used_by: usedBy.get(`${CORPUS_REL}/${m.file}`) ?? [],
    }))
  : []

// Copy every image a case or the corpus shows, and every edited image a
// result shows (results/edits/, from the edit suite), into the site's public
// folder, at its repo path.
const edited = results.flatMap((r) => (r.edit?.image ? [r.edit.image] : []))
for (const path of new Set([...usedBy.keys(), ...corpus.map((m) => m.path), ...edited])) {
  if (edited.includes(path) && !existsSync(join(ROOT, path))) continue // a stale record whose image was removed
  const to = join(PUBLIC_OUT, path)
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(join(ROOT, path), to)
}

/** Every frozen environment and model build, keyed by hash and digest. */
const frozen = (dir: string) =>
  existsSync(dir)
    ? Object.fromEntries(
        readdirSync(dir)
          .filter((f) => f.endsWith('.json'))
          .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(dir, f), 'utf8')) as unknown]),
      )
    : {}
const environments = frozen(ENV_DIR)
const builds = frozen(MODEL_DIR)

mkdirSync(DATA_OUT, { recursive: true })
writeFileSync(
  join(DATA_OUT, 'evals.json'),
  JSON.stringify({ generated_at: new Date().toISOString(), scope: SCOPE, machines, models, suites: suiteData, cells, perf, results, history, runs, environments, builds, corpus }),
)
console.log(`${results.length} results, ${perf.length} speed rows, ${runs.length} runs → ${relative(ROOT, join(DATA_OUT, 'evals.json'))}`)
