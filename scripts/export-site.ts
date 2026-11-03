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
import { compareSimilarity, type ExpectedSimilarity, type SimilarityDetail } from '../assertions/similarity.ts'
import { ENV_DIR, MODEL_DIR } from './env.ts'
import type { CorpusImage } from './fetch-corpus.ts'
import { CATALOG } from './catalog.ts'
import { MODELS, ageMonths, skipReason } from './models.ts'
import { ROOT, SCOPE, SUITES_DIR, currentSnapshot, latest, loadCases, readLedger, readSnapshot, type LedgerRecord } from './ledger.ts'

interface CaseDef {
  description?: string
  metadata?: { id?: string; supersedes?: string; retired?: string }
  vars?: Record<string, unknown>
}

/** The vars that a person reads as the case's input, by suite. */
const INPUT_VARS = ['note', 'log', 'request', 'item', 'image', 'input']

/** A candidate in a similarity suite's pool (suites/<suite>/pool.yaml). */
interface PoolEntry { id: string; file: string; kind: string; of?: string }

/** A suite's candidate pool by id, read from a snapshot's setup (`defaultTest.vars.pool`, with the file inlined); empty for suites without one. */
function poolOf(setup: unknown): Map<string, PoolEntry> {
  const pool = (setup as { defaultTest?: { vars?: { pool?: unknown } } } | null)?.defaultTest?.vars?.pool
  return new Map(Array.isArray(pool) ? (pool as PoolEntry[]).map((p) => [p.id, p] as const) : [])
}
const currentPools = new Map<string, Map<string, PoolEntry>>()
const currentPool = (suite: string) => {
  if (!currentPools.has(suite)) currentPools.set(suite, poolOf(currentSnapshot(suite).setup))
  return currentPools.get(suite)!
}


function inputOf(suite: string, vars: Record<string, unknown> = {}): { text: string; image?: string } {
  // A similarity case names its query by candidate id; the pool says where the image is.
  const query = vars['query']
  const file = typeof query === 'string' ? currentPool(suite).get(query)?.file : undefined
  if (typeof query === 'string' && file) return { text: query, image: file }
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
function compare(expected: unknown, absent: unknown, output: string, detail?: unknown, pool = new Map<string, PoolEntry>()) {
  // Similarity: the top candidates with their levels, and the per-level numbers the scorer recorded.
  if (isSimilarity(expected)) {
    const top = compareSimilarity(expected, output)
    return {
      similarity: {
        top: (top ?? []).flatMap((t) => {
          const file = pool.get(t.id)?.file
          return file ? [{ ...t, path: file }] : []
        }),
        detail: (detail as SimilarityDetail | null | undefined) ?? null,
      },
    }
  }
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

const isSimilarity = (e: unknown): e is ExpectedSimilarity =>
  !!e && typeof e === 'object' && !Array.isArray(e) && ['copy', 'edit', 'scene', 'class'].some((k) => Array.isArray((e as Record<string, unknown>)[k])) && !('changed' in e)

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

/**
 * The task families the site groups quality suites by (leaderboard sections), in
 * display order. The one place that says which suite belongs where: a suite no
 * family claims lands in `other`.
 */
const FAMILIES: { id: string; title: string; blurb: string; has: (suite: string) => boolean }[] = [
  { id: 'text', title: 'Text', blurb: 'Notes and logs in, a label, fields or a tool choice out.', has: (s) => ['classify', 'extract', 'food-lookup', 'orchestrate', 'route', 'workout'].includes(s) },
  { id: 'vision', title: 'Vision understanding', blurb: 'A photo in, text or a flag out.', has: (s) => ['ocr', 'tag-image', 'nudity-flag'].includes(s) },
  { id: 'regions', title: 'Regions', blurb: 'A photo in, boxes around things out.', has: (s) => s.startsWith('regions-') },
  { id: 'image', title: 'Image', blurb: 'Edit an image as told, or tell which images are alike.', has: (s) => ['edit', 'similarity'].includes(s) },
]
const familyOf = (suite: string) => FAMILIES.find((f) => f.has(suite))?.id ?? 'other'

/** The provider labels a suite's current setup runs. */
const providersOf = (setup: unknown): string[] =>
  ((setup as { providers?: { label?: string }[] } | null)?.providers ?? []).flatMap((p) => (p.label ? [p.label] : []))

const suiteData = suites.map((suite) => {
  const snap = currentSnapshot(suite)
  const files = loadCases(suite)
  const description = (snap.setup as { description?: string } | null)?.description ?? suite
  return {
    id: suite,
    kind: suite.startsWith('perf') ? 'perf' : 'quality',
    family: familyOf(suite),
    /** What the suite tests: its description after the "<name> — ". */
    about: description.replace(/^[^—]*—\s*/, ''),
    /** The models the suite's current setup lists as providers. */
    models: providersOf(snap.setup),
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

/** The per-image time a provider reports (detect_ms, classify_ms, embed_ms, edit_ms), when it does. */
const IMAGE_MS = ['detect_ms', 'classify_ms', 'embed_ms', 'edit_ms']
const imageMs = (r: LedgerRecord): number | null => {
  for (const k of IMAGE_MS) {
    const v = r.metrics?.[k]
    if (v !== undefined && Number.isFinite(v)) return v
  }
  return null
}
const runtimeOf = (label: string): 'ollama' | 'onnx' | 'mflux' | 'local' => MODELS.find((e) => e.label === label)?.runtime ?? 'ollama'

/**
 * How long a model takes on a suite: the median per-image time when the
 * provider reports one (a cached embedding makes later cases ~0 s, so case
 * latency would mislead), else the median case latency.
 */
function timeOf(rs: LedgerRecord[]): { time_ms: number | null; time_per: 'image' | 'case' } {
  const per = median(rs.flatMap((r) => imageMs(r) ?? []))
  return per !== null ? { time_ms: per, time_per: 'image' } : { time_ms: median(rs.map((r) => r.latency_ms)), time_per: 'case' }
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
    ...timeOf(v.records),
  }))
const cellTime = new Map(cells.map((c) => [[c.machine, c.model, c.suite].join('\u0000'), c] as const))

/** In-process and local models: per suite, the per-image time, load time and memory. */
const inproc = view
  .filter((v) => !v.suite.startsWith('perf') && runtimeOf(v.model) !== 'ollama')
  .map((v) => {
    const metrics = (key: string) => v.records.flatMap((r) => (r.metrics?.[key] !== undefined && Number.isFinite(r.metrics[key]) ? [r.metrics[key]!] : []))
    const peak = metrics('peak_mb')
    const rss = metrics('rss_mb')
    const mem = peak.length > 0 ? peak : rss
    return {
      machine: v.machine,
      model: v.model,
      suite: v.suite,
      run: v.run,
      stale: v.stale,
      per_image_ms: median(metrics('detect_ms').concat(metrics('classify_ms'), metrics('embed_ms'), metrics('edit_ms'))),
      load_ms: median(metrics('load_ms')),
      /** The largest reading: `rss` is the whole process's resident memory (an upper bound for the model), `peak` the editor's own peak. */
      mem_mb: mem.length > 0 ? Math.max(...mem) : null,
      mem_kind: peak.length > 0 ? ('peak' as const) : ('rss' as const),
    }
  })

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
        // Per-image time when the provider reports one (this case's, else the model's median on the suite), else case latency.
        ...(() => {
          const own = imageMs(r)
          const cell = cellTime.get([v.machine, v.model, v.suite].join('\u0000'))
          return own !== null ? { time_ms: own, time_per: 'image' as const } : cell?.time_per === 'image' ? { time_ms: cell.time_ms, time_per: 'image' as const } : { time_ms: r.latency_ms, time_per: 'case' as const }
        })(),
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
        ...compare(c?.expected, c?.absent, r.output ?? '', r.detail, poolOf(readSnapshot(r.suite, r.suite_fp)?.setup)),
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
    const runtime = entry?.runtime ?? 'ollama'
    const hf = runtime === 'onnx' || runtime === 'mflux'
    return {
      ...m,
      runtime,
      /** Where the weights come from, for a subtitle and a link; `revision` is the pinned commit (or code version). */
      source: {
        label: hf ? 'Hugging Face' : runtime === 'local' ? 'Local code' : 'Ollama tag',
        id: m.tag,
        url: hf ? `https://huggingface.co/${m.tag}` : null,
        revision: entry?.revision ?? null,
        revision_url: hf && entry?.revision ? `https://huggingface.co/${m.tag}/commit/${entry.revision}` : null,
      },
      released: entry?.released ?? null,
      released_approx: entry?.approx ?? false,
      age_months: entry ? ageMonths(entry.released) : null,
      baseline: entry?.baseline ?? null,
      catalog: CATALOG[m.label] ?? null,
      retired: entry ? skipReason(entry) : 'no longer in scripts/models.ts',
    }
  })

/** The leaderboard, per machine: task families, each with its suites' rankings and a matrix of models that have a result in it. */
const quality = suiteData.filter((s) => s.kind === 'quality')
const familyDefs = [...FAMILIES.map((f) => ({ id: f.id, title: f.title, blurb: f.blurb })), { id: 'other', title: 'Other', blurb: '' }]
const leaderboard = machines.map((machine) => {
  const mine = cells.filter((c) => c.machine === machine.key)
  const families = familyDefs.flatMap((f) => {
    const fs = quality.filter((s) => s.family === f.id)
    const fc = mine.filter((c) => fs.some((s) => s.id === c.suite))
    if (fc.length === 0) return []
    const rows = [...new Set(fc.map((c) => c.model))].map((label) => {
      const m = models.find((x) => x.label === label)
      const bySuite = Object.fromEntries(fc.filter((c) => c.model === label).map((c) => [c.suite, c]))
      const present = Object.values(bySuite)
      const speed = perf.find((p) => p.machine === machine.key && p.model === label && p.case === 'ctx-8k')
      return {
        model: label,
        url: m?.catalog?.url ?? null,
        released: m?.released ?? null,
        released_approx: m?.released_approx ?? false,
        baseline: m?.baseline ?? null,
        retired: m?.retired ?? null,
        kind: m?.catalog?.kind ?? null,
        parameters: m?.catalog?.parameters ?? null,
        parameters_note: m?.catalog?.parameters_note ?? null,
        licence: m?.catalog?.licence ?? null,
        cells: bySuite,
        avg: present.reduce((sum, c) => sum + (100 * c.passed) / c.total, 0) / present.length,
        covered: present.length,
        decode_tps: speed?.decode_tps ?? null,
        loaded_gb: speed?.loaded_gb ?? null,
      }
    })
    rows.sort((a, b) => b.avg - a.avg || a.model.localeCompare(b.model))
    const ranking = fs.flatMap((s) => {
      const ranks = fc
        .filter((c) => c.suite === s.id)
        .map((c) => ({ model: c.model, passed: c.passed, total: c.total, mean: c.mean, time_ms: c.time_ms, time_per: c.time_per, stale: c.stale }))
        .sort((a, b) => b.passed / b.total - a.passed / a.total || b.mean - a.mean || (a.time_ms ?? Infinity) - (b.time_ms ?? Infinity))
      return ranks.length === 0 ? [] : [{ suite: s.id, about: s.about, cases: s.cases.length, ranks }]
    })
    return { ...f, suites: fs.filter((s) => ranking.some((r) => r.suite === s.id)).map((s) => ({ id: s.id, about: s.about, cases: s.cases.length })), ranking, rows, has_speed: rows.some((r) => r.decode_tps !== null) }
  })
  return { machine, families }
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
// A similarity result shows its top candidates: corpus images, copies and edit outputs.
const ranked = results.flatMap((r) => r.similarity?.top.map((t) => t.path) ?? [])
const optional = new Set([...edited, ...ranked])
for (const path of new Set([...usedBy.keys(), ...corpus.map((m) => m.path), ...optional])) {
  if (optional.has(path) && !existsSync(join(ROOT, path))) continue // a stale record whose image was removed
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
  JSON.stringify({ generated_at: new Date().toISOString(), scope: SCOPE, machines, models, suites: suiteData, cells, perf, inproc, leaderboard, results, history, runs, environments, builds, corpus }),
)
console.log(`${results.length} results, ${perf.length} speed rows, ${runs.length} runs → ${relative(ROOT, join(DATA_OUT, 'evals.json'))}`)
