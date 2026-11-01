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
  median_ms: number | null
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
  /** For expected fields: what the model returned for each. */
  fields?: { field: string; want: unknown; got: unknown; ok: boolean }[] | null
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

export interface Environment {
  hardware: Record<string, string | number>
  os: { name: string; version: string; build: string; kernel: string }
  power: string
  runtime: { ollama: string; ollama_started: string | null; ollama_settings: Record<string, string>; promptfoo: string; bun: string; node: string }
}

export interface CaseView {
  id: string
  hash: string
  description: string
  input: { text: string; image?: string }
  expected: unknown
  /** Tags that would be wrong for the image (tag-image suite). */
  absent: unknown
  args: unknown
  supersedes: string | null
  retired: string | null
}

export interface Suite {
  id: string
  kind: 'perf' | 'quality'
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
    retired: string | null
  }[]
  suites: Suite[]
  cells: Cell[]
  perf: Perf[]
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

export const pct = (passed: number, total: number) => (total === 0 ? 0 : Math.round((100 * passed) / total))
export const fmt = (n: number | null | undefined, digits = 1) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toFixed(digits))
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
