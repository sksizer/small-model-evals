// Enforces the immutability rules in scripts/ledger.ts. Fails when:
//
// - a case file's id differs from its file name, or two cases share an id;
// - a case that any snapshot names is gone, or its content changed;
// - a snapshot's name no longer matches its content;
// - a ledger record names a snapshot that does not exist;
// - a record names an environment or model build with no frozen file;
// - a ledger line at EVALS_BASE was changed or removed (lines may only be added);
// - a registry model has no scripts/catalog.ts entry with url, kind, publisher and licence;
// - a corpus image differs from the sha256 in corpus/manifest.json, or a case
//   names a corpus image the manifest does not list;
// - a suite's candidate pool (suites/<suite>/pool.yaml) names a file that is
//   missing, a corpus image the manifest does not list, or a case's query or
//   expected id that is not in the pool;
// - a suite's search corpora (suites/<suite>/corpora.yaml) name an image file that is
//   missing, not in the manifest or marked sensitive, or a case's relevant id is not
//   in its corpus.
//
// - a suite has no entry in SUITE_META (scripts/plan.ts) or an entry names a suite that is gone;
// - a machine profile (machines/<name>.yaml) names a category, cost, suite, model or class that
//   does not exist, or two profiles claim the same machine key or class;
// - a run's results/conditions/<run>.json is not named by its run;
// - a corpus image's licence is not one docs/standards/corpus.md allows (CC0,
//   public domain, CC BY; Open Images exactly CC BY 2.0; a derived copy must
//   match its parent). See scripts/licences.ts.
//
//   bun scripts/check.ts
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { spawnRunner } from '@osdlc/command-seam'
import type { CorpusImage } from './fetch-corpus.ts'
import { CATALOG } from './catalog.ts'
import { ENV_DIR, MODEL_DIR } from './env.ts'
import { licenceProblem } from './licences.ts'
import { MODELS } from './models.ts'
import { ALL_CLASSES } from './machine.ts'
import { CATEGORIES, COSTS, SUITE_META, loadProfiles } from './plan.ts'
import { LEDGER_DIR, RESULTS_DIR, ROOT, SCOPE, SUITES_DIR, listSnapshots, loadCases, readLedger, readSnapshot, snapshotIntegrity } from './ledger.ts'

const problems: string[] = []

// Cases: loadCases throws on an id that differs from its file name.
const cases = new Map<string, { hash: string; path: string }>()
for (const suite of readdirSync(SUITES_DIR)) {
  try {
    for (const c of loadCases(suite)) {
      const key = `${suite}/${c.id}`
      if (cases.has(key)) problems.push(`${suite}: two cases with id ${c.id}`)
      cases.set(key, { hash: c.hash, path: relative(ROOT, c.path) })
    }
  } catch (err) {
    problems.push(String(err))
  }
}

// Snapshots: self-consistent, and every case they name is still there, unchanged.
for (const snap of listSnapshots()) {
  const broken = snapshotIntegrity(snap)
  if (broken) problems.push(`${snap.suite}: ${broken}`)
  for (const [id, frozen] of Object.entries(snap.cases)) {
    const now = cases.get(`${snap.suite}/${id}`)
    if (!now) problems.push(`${snap.suite}/${id}: in snapshot ${snap.fingerprint} but the case file is gone; move it to cases/retired/ instead`)
    else if (now.hash !== frozen.hash) {
      problems.push(`${now.path}: changed after snapshot ${snap.fingerprint} used it; add a new case with \`metadata.supersedes\` instead`)
    }
  }
}

// Records: each names a snapshot that exists and holds its case.
for (const r of readLedger()) {
  const snap = readSnapshot(r.suite, r.suite_fp)
  if (!snap) problems.push(`ledger ${r.suite} run ${r.run}: no snapshot ${r.suite_fp}`)
  else if (!snap.cases[r.case]) problems.push(`ledger ${r.suite} run ${r.run}: snapshot ${r.suite_fp} has no case ${r.case}`)
  if (r.env && !existsSync(join(ENV_DIR, `${r.env}.json`))) problems.push(`ledger ${r.suite} run ${r.run}: no environment ${r.env}`)
  if (r.env && !existsSync(join(MODEL_DIR, `${r.model.digest}.json`))) {
    problems.push(`ledger ${r.suite} run ${r.run}: no model file for ${r.model.label} (${r.model.digest})`)
  }
}

// Ledger files: the content at EVALS_BASE (default HEAD; CI passes the
// commit before the push) must be a prefix of the working file.
const git = spawnRunner('git')
const base = process.env['EVALS_BASE'] || 'HEAD'
if (existsSync(LEDGER_DIR)) {
  for (const f of readdirSync(LEDGER_DIR).filter((x) => x.endsWith('.jsonl'))) {
    const path = relative(ROOT, join(LEDGER_DIR, f))
    const committed = git.run(['show', `${base}:${path}`], { cwd: ROOT })
    if (committed.exitCode !== 0) continue // not committed yet
    if (!readFileSync(join(LEDGER_DIR, f), 'utf8').startsWith(committed.stdout)) {
      problems.push(`${path}: committed lines were changed or removed; the ledger is append-only`)
    }
  }
}

// Corpus: images are immutable like cases; a new image gets a new id.
const corpus = SCOPE === 'private' ? join(ROOT, 'private', 'corpus') : join(ROOT, 'corpus')
const manifestPath = join(corpus, 'manifest.json')
const manifest = existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as CorpusImage[]) : []
for (const m of manifest) {
  const path = join(corpus, m.file)
  if (!existsSync(path)) problems.push(`corpus/${m.file}: in the manifest but missing`)
  else if (createHash('sha256').update(readFileSync(path)).digest('hex') !== m.sha256) problems.push(`corpus/${m.file}: changed; add it under a new id`)
}
// Licences: docs/standards/corpus.md. A failure names the image id.
const manifestById = new Map(manifest.map((m) => [m.id, m]))
for (const m of manifest) {
  const problem = licenceProblem(m, manifestById)
  if (problem) problems.push(`corpus: ${problem}`)
}
const listed = new Set(manifest.map((m) => m.file))
for (const suite of readdirSync(SUITES_DIR)) {
  for (const c of loadCases(suite)) {
    const image = (c.def as { vars?: { image?: unknown } }).vars?.image
    const m = typeof image === 'string' ? /corpus\/(images\/[^/]+)$/.exec(image) : null
    // Private cases may also use the public corpus; those are checked in the public scope.
    if (m && !listed.has(m[1]!)) problems.push(`${suite}/${c.id}: image ${m[1]} is not in corpus/manifest.json`)
  }
}

// Candidate pools (the similarity suite): the files exist and the cases' ids resolve.
for (const suite of readdirSync(SUITES_DIR)) {
  const poolPath = join(SUITES_DIR, suite, 'pool.yaml')
  if (!existsSync(poolPath)) continue
  const pool = Bun.YAML.parse(readFileSync(poolPath, 'utf8')) as { id: string; file: string; of?: string }[]
  const ids = new Set(pool.map((p) => p.id))
  for (const p of pool) {
    if (!existsSync(join(ROOT, p.file))) problems.push(`${suite}/pool.yaml: ${p.id}: ${p.file} is missing`)
    const m = /^corpus\/(images\/[^/]+)$/.exec(p.file)
    if (m && !listed.has(m[1]!)) problems.push(`${suite}/pool.yaml: ${p.id}: ${m[1]} is not in corpus/manifest.json`)
    if (p.of && !ids.has(p.of)) problems.push(`${suite}/pool.yaml: ${p.id}: of ${p.of} is not in the pool`)
  }
  for (const c of loadCases(suite)) {
    const vars = c.def['vars'] as { query?: string; expected?: Record<string, string[]> } | undefined
    for (const id of [vars?.query, ...Object.values(vars?.expected ?? {}).flat()]) {
      if (typeof id === 'string' && !ids.has(id)) problems.push(`${suite}/${c.id}: ${id} is not in pool.yaml`)
    }
  }
}

// Search corpora (the search suite): image files exist, are in the manifest and are never marked sensitive;
// every case's relevant ids resolve in its corpus.
for (const suite of readdirSync(SUITES_DIR)) {
  const path = join(SUITES_DIR, suite, 'corpora.yaml')
  if (!existsSync(path)) continue
  const corpora = Bun.YAML.parse(readFileSync(path, 'utf8')) as Record<string, { id: string; file?: string }[]>
  const sensitive = new Set(manifest.filter((m) => m.sensitive).map((m) => `corpus/${m.file}`))
  for (const [name, items] of Object.entries(corpora)) {
    for (const it of items) {
      if (!it.file) continue
      if (!existsSync(join(ROOT, it.file))) problems.push(`${suite}/corpora.yaml: ${name}/${it.id}: ${it.file} is missing`)
      if (sensitive.has(it.file)) problems.push(`${suite}/corpora.yaml: ${name}/${it.id}: a sensitive image must not be searched`)
      const m = /^corpus\/(images\/[^/]+)$/.exec(it.file)
      if (m && !listed.has(m[1]!)) problems.push(`${suite}/corpora.yaml: ${name}/${it.id}: ${m[1]} is not in corpus/manifest.json`)
    }
  }
  for (const c of loadCases(suite)) {
    const vars = c.def['vars'] as { corpus?: string; relevant?: string[] } | undefined
    const ids = new Set((corpora[vars?.corpus ?? ''] ?? []).map((i) => i.id))
    if (ids.size === 0) problems.push(`${suite}/${c.id}: corpus ${vars?.corpus} is not in corpora.yaml`)
    for (const id of vars?.relevant ?? []) if (!ids.has(id)) problems.push(`${suite}/${c.id}: relevant id ${id} is not in the ${vars?.corpus} corpus`)
  }
}

// Catalogue: every registry model says where it comes from and under what licence.
for (const m of MODELS) {
  const c = CATALOG[m.label]
  if (!c) problems.push(`${m.label}: in scripts/models.ts but has no entry in scripts/catalog.ts`)
  else for (const k of ['url', 'kind', 'publisher', 'licence'] as const) if (!c[k]) problems.push(`${m.label}: scripts/catalog.ts entry lacks ${k}`)
}
for (const label of Object.keys(CATALOG)) {
  if (!MODELS.some((m) => m.label === label)) problems.push(`${label}: in scripts/catalog.ts but not in scripts/models.ts`)
}

// Categories: every suite is declared once in SUITE_META, with real categories and a cost.
if (SCOPE === 'public') {
  const suiteDirs = readdirSync(SUITES_DIR)
  for (const s of suiteDirs) if (!SUITE_META[s]) problems.push(`${s}: suite has no entry in SUITE_META (scripts/plan.ts)`)
  for (const [s, meta] of Object.entries(SUITE_META)) {
    if (!suiteDirs.includes(s)) problems.push(`SUITE_META: ${s} is not a suite`)
    if (meta.categories.length === 0) problems.push(`SUITE_META: ${s} has no category`)
    for (const c of meta.categories) if (!(CATEGORIES as readonly string[]).includes(c)) problems.push(`SUITE_META: ${s}: unknown category ${c}`)
    if (!(COSTS as readonly string[]).includes(meta.cost)) problems.push(`SUITE_META: ${s}: unknown cost ${meta.cost}`)
  }
}

// Machine profiles: they name only things that exist, and each machine matches one.
{
  const classes = new Set(ALL_CLASSES.map((c) => c.class))
  const claimed = new Map<string, string>()
  const claim = (what: string, by: string) => {
    if (claimed.has(what)) problems.push(`machines/${by}.yaml: ${what} is already claimed by ${claimed.get(what)}`)
    else claimed.set(what, by)
  }
  for (const p of loadProfiles()) {
    const at = `machines/${p.name}.yaml`
    for (const c of p.categories ?? []) if (!(CATEGORIES as readonly string[]).includes(c)) problems.push(`${at}: unknown category ${c}`)
    if (p.cost !== undefined && !(COSTS as readonly string[]).includes(p.cost)) problems.push(`${at}: unknown cost ${p.cost}`)
    for (const s of p.suites ?? []) if (!SUITE_META[s]) problems.push(`${at}: unknown suite ${s}`)
    for (const m of [...(p.models ?? []), ...(p.skip_models ?? [])]) if (!MODELS.some((x) => x.label === m)) problems.push(`${at}: unknown model ${m}`)
    for (const c of p.match?.classes ?? []) {
      if (!classes.has(c)) problems.push(`${at}: unknown class ${c} (see scripts/machine.ts)`)
      claim(`class ${c}`, p.name)
    }
    for (const k of p.match?.keys ?? []) claim(`key ${k}`, p.name)
  }
}

// Conditions: one file per run, named by it.
const condDir = join(RESULTS_DIR, 'conditions')
if (existsSync(condDir)) {
  for (const f of readdirSync(condDir).filter((x) => x.endsWith('.json'))) {
    const rc = JSON.parse(readFileSync(join(condDir, f), 'utf8')) as { run?: string }
    if (`${rc.run}.json` !== f) problems.push(`results/conditions/${f}: names run ${rc.run}`)
  }
}

if (problems.length > 0) {
  console.error(problems.map((p) => `- ${p}`).join('\n'))
  process.exit(1)
}
console.log(`ok: ${cases.size} cases, ${listSnapshots().length} snapshots, ${manifest.length} corpus images, ledger consistent`)
