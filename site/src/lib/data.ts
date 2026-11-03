// Typed access to evals.json, written by ../scripts/export-site.ts (src/data/,
// or private/site/data/ for the private build), and the formatting helpers
// every page shares.
import raw from '@data/evals.json'

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

/** What a time is per: one image (the provider's own measure) or one case (the case's latency). */
export type TimePer = 'image' | 'case'

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
  /** For expected fields: what the model returned for each. */
  fields?: { field: string; want: unknown; got: unknown; ok: boolean }[] | null
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
  hardware: Record<string, string | number>
  os: { name: string; version: string; build: string; kernel: string }
  power: string
  runtime: { ollama: string; ollama_started: string | null; ollama_settings: Record<string, string>; promptfoo: string; bun: string; node: string }
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
  }[]
  suites: Suite[]
  cells: Cell[]
  perf: Perf[]
  inproc: InProc[]
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

/** A URL-safe slug for a model label such as `qwen3.5:4b`. */
export const modelSlug = (label: string) => label.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')

/** A parameter count as people write it: 137M, 4.0B. */
export const fmtParams = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : n >= 1e9 ? `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B` : `${Math.round(n / 1e6)}M`

/** A download size in GB or MB. */
export const fmtDisk = (gb: number | null | undefined) =>
  gb === null || gb === undefined ? '—' : gb >= 1 ? `${gb.toFixed(1)} GB` : gb >= 0.01 ? `${Math.round(gb * 1000)} MB` : `${(gb * 1000).toFixed(2)} MB`

/** A link's host and path, for showing a URL compactly. */
export const shortUrl = (u: string) => u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')

export const pct = (passed: number, total: number) => (total === 0 ? 0 : Math.round((100 * passed) / total))
export const fmt = (n: number | null | undefined, digits = 1) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toFixed(digits))
/** A time as people read it: ms below a second, else seconds; "/img" when it is per image. */
export const fmtTime = (ms: number | null | undefined, per: TimePer = 'case') => {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  const t = ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : ms >= 10 ? `${Math.round(ms)} ms` : `${ms.toFixed(1)} ms`
  return per === 'image' ? `${t}/img` : t
}
export const runDate = (run: string) => run.slice(0, 10)

/** A tone for a pass rate, for heat-coloured cells. */
export const tone = (rate: number) => (rate >= 90 ? 'good' : rate >= 70 ? 'ok' : rate >= 50 ? 'warn' : 'bad')

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
