// Typed access to evals.json, written by ../scripts/export-site.ts (src/data/,
// or private/site/data/ for the private build), and the formatting helpers
// every page shares.
import raw from '@data/evals.json'
import type { TimePer } from './format'

export { fmt, fmtDisk, fmtParams, fmtTime, modelSlug, pct, tone, type TimePer } from './format'

export interface Cell {
  machine: string
  model: string
  suite: string
  run: string
  stale: boolean
  passed: number
  total: number
  missing: string[]
  mean: number
  /** Median time: per image when the provider reports one (`time_per` is `image`), else per case. */
  time_ms: number | null
  time_per: TimePer
}

/** A model's per-image cost on one suite, for an in-process or local model. */
export interface InProc {
  machine: string
  model: string
  suite: string
  run: string
  stale: boolean
  per_image_ms: number | null
  load_ms: number | null
  mem_mb: number | null
  /** `rss` is the whole process's resident memory (an upper bound); `peak` the editor's own peak. */
  mem_kind: 'rss' | 'peak'
  busy: string[]
}

export interface Ranked {
  model: string
  passed: number
  total: number
  mean: number
  time_ms: number | null
  time_per: TimePer
  stale: boolean
}

export interface LeaderRow {
  model: string
  url: string | null
  released: string | null
  released_approx: boolean
  baseline: string | null
  retired: string | null
  kind: string | null
  parameters: number | null
  parameters_note: string | null
  licence: string | null
  cells: Record<string, Cell>
  /** Mean pass rate (percent) over the family's suites the model ran. */
  avg: number
  covered: number
  decode_tps: number | null
  loaded_gb: number | null
}

/** A task family on the leaderboard: its suites ranked, and the matrix of models that have a result in it. */
export interface LeaderFamily {
  id: string
  title: string
  blurb: string
  suites: { id: string; about: string; cases: number }[]
  ranking: { suite: string; about: string; cases: number; ranks: Ranked[] }[]
  rows: LeaderRow[]
  has_speed: boolean
}

/** A task the model finder offers: one quality suite in plain words (scripts/export-site.ts TASKS). */
export interface FinderTask {
  /** The suite id. */
  id: string
  label: string
  about: string
  /** The task family's id, for grouping. */
  family: string
}

/** One model's result on one task, for the finder. */
export interface FinderCell {
  /** Pass rate, percent. */
  rate: number
  passed: number
  total: number
  mean: number
  stale: boolean
  time_ms: number | null
  time_per: TimePer
  /** This model's time over the fastest model's on the same suite and machine (1 = fastest); null without a time. */
  rel: number | null
}

/** Memory measured while the model ran: `loaded` is Ollama's loaded size at 8K context, `rss` the process's resident memory (an upper bound), `peak` an editor's own peak. */
export interface FinderMemory {
  gb: number
  basis: 'loaded' | 'rss' | 'peak'
}

/** What a model needs to run, in GiB, and where the number came from (scripts/fit.ts). */
export interface Need {
  gib: number | null
  basis: 'measured' | 'catalogue' | 'unknown'
  note: string
}

export type FitStatus = 'fits' | 'tight' | 'offload' | 'wont' | 'unknown'

/** One model on one machine, with its result on every task it ran. */
export interface FinderRow {
  machine: string
  /** Its memory need, and whether that fits each class of machine (scripts/machine.ts TIERS). */
  need: Need
  fits: Record<string, FitStatus>
  model: string
  kind: string | null
  publisher: string | null
  licence: string | null
  /** The licence lets anyone use it commercially without asking (Apache, MIT, BSD, CC0 and the like). */
  permissive: boolean
  parameters: number | null
  parameters_note: string | null
  disk_gb: number | null
  runtime: 'ollama' | 'onnx' | 'mflux' | 'local'
  released: string | null
  released_approx: boolean
  baseline: string | null
  retired: string | null
  memory: FinderMemory | null
  cells: Record<string, FinderCell>
}

export interface Perf {
  machine: string
  model: string
  suite: string
  case: string
  run: string
  stale: boolean
  load_s: number | null
  prompt_tps: number | null
  prompt_cached: boolean
  decode_tps: number | null
  embeds_per_s: number | null
  loaded_gb: number | null
  gpu_pct: number | null
  /** Why this run was taken on a busy machine (results/conditions/); empty when clean or not recorded. */
  busy: string[]
}

export interface Result {
  machine: string
  model: string
  suite: string
  case: string
  description: string
  input: string
  image: string | null
  expected: unknown
  args: unknown
  pass: boolean
  score: number
  latency_ms: number
  /** The time to show: per image when the provider reports one, else the case's latency. */
  time_ms: number
  time_per: TimePer
  reason: string
  error: string
  output: string
  run: string
  stale: boolean
  suite_fp: string
  case_hash: string | null
  env: string | null
  /** For a list of expected strings: which ones the reply contains. */
  hits?: { want: string; found: boolean }[]
  /** For tags: the wrong tags the case lists, and whether the model gave each. */
  wrong?: { want: string; found: boolean }[]
  /** For tags: the model's tag list, or null when the reply did not parse. */
  tags?: string[] | null
  /** Numbers the provider reported for this case (detect_ms, rss_mb, load_ms, ...). */
  metrics?: Record<string, number> | null
  /** For regions: each expected box with the box matched to it (or null), then each extra box. Boxes are [x0, y0, x1, y1] as fractions. */
  regions?: { label: string; want: Box | null; got: Box | null; iou: number | null; ok: boolean }[] | null
  /** The instruction an edit case gives the model. */
  instruction?: string | null
  /** For an edit: the edited image (a repo path), the judge's answer to each question, and how much of the image outside the allowed region stayed the same. */
  edit?: { image: string | null; judge: string | null; answers: { question: string; kind: 'changed' | 'kept'; answer: 'yes' | 'no' | null; ok: boolean }[]; preservation: { diff: number; max: number; ok: boolean } | null }
  /** For a similarity result: the model's top candidates with how they relate to the query, and the scorer's per-level numbers. */
  similarity?: { top: RankedCandidate[]; detail: SimilarityDetail | null }
  /** For a search result: the model's top five with whether each is relevant, and the scorer's numbers. */
  search?: { top: SearchCandidate[]; detail: SearchDetail | null }
  /** For the sensitive suite: the scorer's grading of the reply. */
  screening?: Screening | null
  /** For expected fields: what the model returned for each. */
  fields?: { field: string; want: unknown; got: unknown; ok: boolean }[] | null
}

/** The sensitive suite's categories and levels (assertions/sensitive-levels.ts). */
export type Category = 'nudity' | 'intimate' | 'minor' | 'face' | 'id-document' | 'financial' | 'screen' | 'medical' | 'location' | 'credential' | 'document'
export type PrivacyLevel = 'public' | 'review' | 'private'

/** What assertions/sensitive.ts recorded for one result: the categories hit, missed and raised falsely, the levels, and the model's risks. */
export interface Screening {
  expected_level: PrivacyLevel
  predicted_level: PrivacyLevel
  outcome: 'exact' | 'leak' | 'false-alarm'
  expected: Category[]
  predicted: Category[]
  hits: Category[]
  misses: Category[]
  false_alarms: Category[]
  precision: number
  recall: number
  f1: number
  risks: Partial<Record<Category, number>>
  score: number
}

/** A sensitive-suite case's expectation: every category the image shows. */
export const isScreening = (e: unknown): e is { categories: Category[] } =>
  !!e && typeof e === 'object' && Array.isArray((e as { categories?: unknown }).categories)

/** One model's summary on the sensitive suite (scripts/export-site.ts `screening`). */
export interface ScreeningModel {
  machine: string
  model: string
  stale: boolean
  total: number
  errors: number
  exact: number
  /** Private images called public: the owner's pass mark is zero. */
  leaks: number
  private_cases: number
  /** Images called a lower level than they are. */
  under_calls: number
  /** Images called a higher level than they are. */
  false_alarms: number
  public_cases: number
  public_flagged: number
  mean_score: number
  time_ms: number | null
  time_per: TimePer
  memory: FinderMemory | null
  loaded_gb: number | null
  per_category: Record<Category, { tp: number; fp: number; fn: number; precision: number | null; recall: number | null }>
  curve: { t: number; leaks: number; under: number; false_alarms: number }[]
  /** The composite's stage use over the images it screened. */
  stages: { images: number; decided_by: Record<string, number>; ran: Record<string, { n: number; median_ms: number | null }> } | null
}

/** One ranked candidate of a search result: a corpus image (`path`) or text (`text`, with its `title`). */
export interface SearchCandidate {
  id: string
  score: number
  relevant: boolean
  path?: string
  text?: string
  title?: string | null
}

/** What assertions/search.ts records per case. */
export interface SearchDetail {
  kind: string
  ndcg10: number
  r1: number
  r5: number
  r10: number
  mrr: number
  ndcg10_256: number | null
  relevant: number
}

/** A search case's expectation: the relevant candidate ids in a named corpus. */
export interface ExpectedSearch {
  relevant: string[]
  corpus: string
  kind: string
  how: string
}
export const isSearch = (e: unknown): e is ExpectedSearch =>
  !!e && typeof e === 'object' && Array.isArray((e as { relevant?: unknown }).relevant) && typeof (e as { corpus?: unknown }).corpus === 'string'

/** One model's search numbers for one kind of case (scripts/export-site.ts `searchCells`). */
export interface SearchCell {
  machine: string
  model: string
  kind: 'photos' | 'docs' | 'text'
  run: string
  stale: boolean
  passed: number
  total: number
  mean: number
  ndcg10: number | null
  r1: number | null
  r5: number | null
  r10: number | null
  mrr: number | null
  ndcg10_256: number | null
  by_corpus: Record<string, number | null>
  time_ms: number | null
  time_per: TimePer
  query_ms: number | null
  load_ms: number | null
  mem_mb: number | null
  loaded_gb: number | null
}

/** How a candidate relates to a similarity query: the case lists the first four, the rest of the pool is `other`. */
export type Level = 'copy' | 'edit' | 'scene' | 'class' | 'other'

/** One ranked candidate of a similarity result (assertions/similarity.ts); `path` is the image's repo path. */
export interface RankedCandidate {
  id: string
  path: string
  score: number
  level: Level
}

/** What assertions/similarity.ts records per case. */
export interface SimilarityDetail {
  levels: Partial<Record<Exclude<Level, 'other'>, { n: number; r1: number; r5: number }>>
  other5: number
  ap: number
  copy_cut: { cut: number; mistakes: number } | null
  same_cut: { cut: number; mistakes: number } | null
}

export interface Build {
  tag: string
  digest: string
  engine: string
  format: string
  family: string
  quantization: string
  parameter_size: string
  parameter_count: number | null
  context_length: number | null
  capabilities: string[]
  default_parameters: Record<string, string>
}

/** What a model is and where to get it (scripts/catalog.ts). */
export interface Catalog {
  url: string
  source_url?: string
  publisher: string
  licence: string
  licence_url?: string
  kind: string
  inputs: string[]
  outputs: string[]
  parameters?: number
  parameters_note?: string
  architecture?: string
  base_model?: string
  disk_gb?: number
  languages?: string
  paper?: string
  notes: string
}

export interface Environment {
  hardware: Record<string, string | number | null>
  os: { name: string; version: string; build: string; kernel: string }
  runtime: Record<string, string | null | Record<string, string>>
}

/** The machine's state at one moment of a run (scripts/conditions.ts). */
export interface Conditions {
  load_1m: number
  load_per_core: number
  mem_available_gib: number
  mem_free_pct: number | null
  swap_used_gib: number
  power: 'ac' | 'battery' | 'unknown'
  low_power_mode: boolean | null
  thermal_limit_pct: number | null
  busy: { name: string; cpu_pct: number }[]
}

/** A box as fractions of the image size: [x0, y0, x1, y1], top left origin. */
export type Box = [number, number, number, number]

/** A regions case's expectation (assertions/regions.ts). */
export interface ExpectedRegions {
  labels?: (string | string[])[]
  boxes: { label: string | string[]; box: Box }[]
}

export const isRegions = (e: unknown): e is ExpectedRegions =>
  !!e && typeof e === 'object' && Array.isArray((e as { boxes?: unknown }).boxes)

const firstLabel = (l: string | string[]) => (Array.isArray(l) ? l[0]! : l)

/** An edit case's expectation (assertions/edit.ts). */
export interface ExpectedEdit {
  changed: string[]
  kept: string[]
  region?: Box
}

export const isEdit = (e: unknown): e is ExpectedEdit =>
  !!e && typeof e === 'object' && Array.isArray((e as { changed?: unknown }).changed) && Array.isArray((e as { kept?: unknown }).kept)

/** A similarity case's expectation (assertions/similarity.ts): the candidate ids at each level. */
export interface ExpectedSimilarity {
  copy?: string[]
  edit?: string[]
  scene?: string[]
  class?: string[]
}

export const isSimilarity = (e: unknown): e is ExpectedSimilarity =>
  !!e && typeof e === 'object' && !Array.isArray(e) && ['copy', 'edit', 'scene', 'class'].some((k) => Array.isArray((e as Record<string, unknown>)[k])) && !('changed' in e)

/** The levels in the order the site lists them, and the ones that mean "the same thing" (the scored ones). */
export const LEVELS: Exclude<Level, 'other'>[] = ['copy', 'edit', 'scene', 'class']
export const SAME_THING: Level[] = ['copy', 'edit', 'scene']

/** A case's expectation in a few words: a regions case as its box count and labels, anything else as JSON. */
export const describeExpected = (e: unknown): string => {
  if (isSearch(e)) return `${e.relevant.length} relevant${e.how ? ` · ${e.how}` : ''}`
  if (isSimilarity(e)) return LEVELS.flatMap((l) => (e[l]?.length ? [`${e[l]!.length} ${l}`] : [])).join(', ')
  if (isEdit(e)) return `${e.changed.length} changed, ${e.kept.length} kept${e.region ? ', edit confined to a region' : ''}: ${[...e.changed, ...e.kept].join(' ')}`
  if (!isRegions(e)) return show(e)
  if (e.boxes.length === 0) return `no ${(e.labels ?? []).map(firstLabel).join(', ') || 'boxes'}`
  const counts = new Map<string, number>()
  for (const b of e.boxes) counts.set(firstLabel(b.label), (counts.get(firstLabel(b.label)) ?? 0) + 1)
  return `${e.boxes.length} box${e.boxes.length === 1 ? '' : 'es'}: ${[...counts].map(([l, n]) => (n > 1 ? `${n} × ${l}` : l)).join(', ')}`
}

export interface CaseView {
  id: string
  hash: string
  description: string
  input: { text: string; image?: string }
  expected: unknown
  /** Tags that would be wrong for the image (tag-image suite). */
  absent: unknown
  /** The instruction an edit case gives the model. */
  instruction: string | null
  args: unknown
  supersedes: string | null
  retired: string | null
}

export interface Suite {
  id: string
  kind: 'perf' | 'quality'
  /** The task family (scripts/export-site.ts FAMILIES). */
  family: string
  /** What the suite tests, one line. */
  about: string
  /** The models the suite lists as providers. */
  models: string[]
  fingerprint: string
  cases: CaseView[]
  retired: CaseView[]
}

export interface Run {
  run: string
  at: string
  machine: string
  ollama: string
  promptfoo: string
  envs: string[]
  models: string[]
  suites: string[]
  records: number
  class: string
  /** How the machine was doing around the run's evals; null for runs made before this was recorded. */
  conditions: { evals: number; flagged: { model: string; suite: string; flags: string[] }[]; first: Conditions | null } | null
}

export interface History {
  machine: string
  model: string
  suite: string
  run: string
  suite_fp: string
  passed: number
  total: number
}

export interface Machine {
  key: string
  chip: string
  hw_model: string
  mem_gib: number
  accel: 'apple' | 'nvidia' | 'cpu'
  gpu: string | null
  vram_gib: number | null
  /** The memory models may fill, GiB. */
  budget_gib: number
  /** Most a model may need and still run by CPU offload. */
  spill_gib: number
  /** Accelerator and memory tier, e.g. `apple-16g` (scripts/machine.ts). */
  class: string
}

/** One corpus image: corpus/manifest.json plus the cases that use it. */
export interface CorpusImage {
  id: string
  category: string
  /** Repo path, also where the site serves it. */
  path: string
  title: string
  /** A Commons page URL, or for a synthetic image its source under corpus/. */
  page: string
  author: string
  licence: string
  licence_url: string | null
  width: number
  height: number
  sha256: string
  /** Shown blurred until the viewer asks to see it (components/Shot.astro). */
  sensitive?: true
  /** For a derived copy (the similarity suite): the corpus image it was made from, and how. */
  derived_from?: string
  recipe?: string
  used_by: { suite: string; case: string; retired: boolean }[]
}

/** The repository the site is built from, for links to source files. */
export const REPO_URL = 'https://github.com/sksizer/small-model-evals'

/** Where a corpus image came from, as a link. */
export const sourceUrl = (m: CorpusImage) => (/^https?:/.test(m.page) ? m.page : `${REPO_URL}/blob/main/corpus/${m.page}`)

export const data = raw as unknown as {
  generated_at: string
  /** `private` for the local-only build of the private suites (scripts/build-site.ts). */
  scope?: 'public' | 'private'
  machines: Machine[]
  /** Every class of machine with its nominal memory budget, GiB. */
  classes: { class: string; accel: string; budget_gib: number; spill_gib: number }[]
  /** A need above this share of a budget is `tight` (scripts/fit.ts). */
  tight: number
  models: {
    label: string
    tag: string
    digest: string
    released: string | null
    released_approx: boolean
    age_months: number | null
    baseline: string | null
    catalog: Catalog | null
    retired: string | null
    runtime: 'ollama' | 'onnx' | 'mflux' | 'local'
    source: { label: string; id: string; url: string | null; revision: string | null; revision_url: string | null }
    need: Need
    fits: Record<string, FitStatus>
  }[]
  suites: Suite[]
  cells: Cell[]
  perf: Perf[]
  inproc: InProc[]
  screening: { categories: { id: Category; definition: string; private: boolean }[]; levels: PrivacyLevel[]; thresholds: number[]; models: ScreeningModel[] } | null
  search: { kinds: ('photos' | 'docs' | 'text')[]; cells: SearchCell[]; items: Record<string, Record<string, { path?: string; title?: string | null; text?: string }>> }
  finder: { families: { id: string; title: string }[]; tasks: FinderTask[]; rows: FinderRow[] }
  leaderboard: { machine: Machine; families: LeaderFamily[] }[]
  results: Result[]
  history: History[]
  runs: Run[]
  environments: Record<string, Environment>
  builds: Record<string, Build>
  corpus: CorpusImage[]
}

export const qualitySuites = data.suites.filter((s) => s.kind === 'quality')
export const modelLabels = data.models.map((m) => m.label)

/** A link's host and path, for showing a URL compactly. */
export const shortUrl = (u: string) => u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')

export const runDate = (run: string) => run.slice(0, 10)

export const show = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v))

/** The base path, so links work when the site is served from a subfolder. */
export const href = (path: string) => `${import.meta.env.BASE_URL.replace(/\/$/, '')}${path}`

const sensitivePaths = new Set(data.corpus.filter((m) => m.sensitive).map((m) => m.path))
/** Whether the image at this repo path is shown blurred until asked for. */
export const isSensitive = (path: string | null | undefined) => !!path && sensitivePaths.has(path)

/** Suites whose cases show an image: they get a gallery view. */
export const imageSuites = qualitySuites.filter((s) => s.cases.some((c) => c.input.image))

/** A model build's details, by the digest a result recorded. */
export const buildOf = (label: string) => {
  const digest = data.models.find((m) => m.label === label)?.digest
  return digest ? data.builds[digest] : undefined
}

/** How a machine reads in a picker or heading: its chip (and card), memory and class. */
export const machineLabel = (m: Machine) => `${m.chip}${m.gpu ? ` + ${m.gpu}` : ''}, ${m.mem_gib} GiB · ${m.class}`
export const machineByKey = (key: string) => data.machines.find((m) => m.key === key)

/** Shown beside a fit status. */
export const FIT_WORDS: Record<FitStatus, string> = { fits: 'fits', tight: 'tight', offload: 'offload', wont: "won't fit", unknown: 'unknown' }
