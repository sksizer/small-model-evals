// What a run (scripts/run.ts) or a setup (scripts/setup.ts) will do on this
// machine: which (model, suite) pairs are selected, and which of them fit.
//
// Selection narrows in three steps, each optional:
//
// 1. A machine profile (machines/<name>.yaml): committed, picked with
//    `--profile <name>`, or matched by this machine's key or class. With none,
//    the default is everything that fits.
// 2. The command line: `--models`, `--suites`, `--category`, `--cost`. A flag
//    replaces the profile's setting of the same name.
// 3. Fit (scripts/fit.ts): a model that will not fit this machine's memory is
//    skipped, loudly, unless `--force`.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MODELS, skipReason, type ModelEntry } from './models.ts'
import { ROOT, SUITES_DIR, latest } from './ledger.ts'
import { describe, type Machine, type MachineInfo } from './machine.ts'
import { fitOf, ranOn, requirementOf, TIGHT, type FitStatus, type Requirement } from './fit.ts'

// ---- categories ----------------------------------------------------------------

/**
 * What kind of work a suite tests. Declared here, not in each suite's
 * promptfooconfig.yaml, because a suite's snapshot freezes that config:
 * adding metadata there would change every suite's fingerprint and make all
 * recorded results look stale. scripts/check.ts fails when a suite has no
 * entry here or an entry names a suite that does not exist.
 */
export const CATEGORIES = ['text', 'vision', 'regions', 'search', 'image-edit', 'audio', 'video'] as const
export type Category = (typeof CATEGORIES)[number]

/** `light` suites load a model and run small cases; `heavy` ones load large models, long contexts or several models at once. */
export const COSTS = ['light', 'heavy'] as const
export type Cost = (typeof COSTS)[number]

/**
 * `case_timeout_min`: how long one case may run before promptfoo fails it (default 5, scripts/run.ts). Suites whose
 * first case embeds a whole corpus (search, similarity) need longer: EmbeddingGemma 2 takes about 2 s an image on
 * CPU, and a 132-image corpus under load ran past 5 minutes on 2026-11-08.
 */
export const SUITE_META: Record<string, { categories: Category[]; cost: Cost; case_timeout_min?: number }> = {
  classify: { categories: ['text'], cost: 'light' },
  extract: { categories: ['text'], cost: 'light' },
  'food-lookup': { categories: ['text'], cost: 'light' },
  orchestrate: { categories: ['text'], cost: 'light' },
  route: { categories: ['text'], cost: 'light' },
  workout: { categories: ['text'], cost: 'light' },
  perf: { categories: ['text'], cost: 'heavy' },
  ocr: { categories: ['vision'], cost: 'light' },
  'tag-image': { categories: ['vision'], cost: 'light' },
  'nudity-flag': { categories: ['vision'], cost: 'light' },
  similarity: { categories: ['vision'], cost: 'light', case_timeout_min: 20 },
  sensitive: { categories: ['vision'], cost: 'heavy' },
  'regions-faces': { categories: ['regions'], cost: 'light' },
  'regions-find': { categories: ['regions'], cost: 'light' },
  'regions-objects': { categories: ['regions'], cost: 'light' },
  'regions-text': { categories: ['regions'], cost: 'light' },
  search: { categories: ['search'], cost: 'heavy', case_timeout_min: 20 },
  'perf-embed': { categories: ['search'], cost: 'heavy' },
  edit: { categories: ['image-edit'], cost: 'heavy' },
}

/** A suite outside the registry (a private one) counts as light and in no category, so it runs by default and by name. */
export const metaOf = (suite: string): { categories: Category[]; cost: Cost; case_timeout_min?: number } => SUITE_META[suite] ?? { categories: [], cost: 'light' }

// ---- profiles ------------------------------------------------------------------

export const PROFILE_DIR = join(ROOT, 'machines')

/** machines/<name>.yaml: what one machine, or one class of machine, runs. Every field but `match` is optional; absent means no limit. */
export interface Profile {
  name: string
  description?: string
  /** Which machines it applies to when not named with `--profile`: by exact key, or by class. */
  match?: { keys?: string[]; classes?: string[] }
  categories?: Category[]
  cost?: Cost
  suites?: string[]
  /** Only these models. */
  models?: string[]
  /** Never these models (an explicit `--models` overrides). */
  skip_models?: string[]
}

export function loadProfiles(dir = PROFILE_DIR): Profile[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => ({ ...(Bun.YAML.parse(readFileSync(join(dir, f), 'utf8')) as Omit<Profile, 'name'>), name: f.replace(/\.yaml$/, '') }))
}

/** The profile for this machine: the one named, else a key match, else a class match; null when none (everything that fits). */
export function chooseProfile(m: Machine, name?: string): { profile: Profile | null; how: string } {
  if (name === 'none') return { profile: null, how: '--profile none' }
  const all = loadProfiles()
  if (name) {
    const p = all.find((x) => x.name === name)
    if (!p) throw new Error(`no profile "${name}" in machines/ (have: ${all.map((x) => x.name).join(', ') || 'none'})`)
    return { profile: p, how: 'named' }
  }
  const info = describe(m)
  const byKey = all.find((p) => p.match?.keys?.includes(m.key))
  if (byKey) return { profile: byKey, how: `matched machine key ${m.key}` }
  const byClass = all.find((p) => p.match?.classes?.includes(info.class))
  return byClass ? { profile: byClass, how: `matched class ${info.class}` } : { profile: null, how: 'none matches' }
}

// ---- selection -----------------------------------------------------------------

export interface Selection {
  models?: Set<string>
  suites?: Set<string>
  categories?: Set<string>
  cost?: Cost
}

/** The command-line options both scripts take (for util.parseArgs). */
export const SELECTION_OPTIONS = {
  models: { type: 'string' },
  suites: { type: 'string' },
  category: { type: 'string' },
  cost: { type: 'string' },
  profile: { type: 'string' },
  force: { type: 'boolean' },
} as const

const csv = (v: string | undefined) => (v ? new Set(v.split(',').filter(Boolean)) : undefined)

export function selectionOf(values: { models?: string; suites?: string; category?: string; cost?: string }): Selection {
  const categories = csv(values.category)
  for (const c of categories ?? []) if (!(CATEGORIES as readonly string[]).includes(c)) throw new Error(`unknown category "${c}" (have: ${CATEGORIES.join(', ')})`)
  if (values.cost !== undefined && !(COSTS as readonly string[]).includes(values.cost)) throw new Error(`unknown cost "${values.cost}" (have: ${COSTS.join(', ')})`)
  const models = csv(values.models)
  const suites = csv(values.suites)
  const known = new Set(MODELS.map((m) => m.label))
  for (const m of models ?? []) if (!known.has(m)) throw new Error(`unknown model "${m}"`)
  for (const s of suites ?? []) if (!existsSync(join(SUITES_DIR, s))) throw new Error(`unknown suite "${s}"`)
  return { ...(models ? { models } : {}), ...(suites ? { suites } : {}), ...(categories ? { categories } : {}), ...(values.cost ? { cost: values.cost as Cost } : {}) }
}

/**
 * The model labels each suite's config lists, with the case kinds a provider limits itself to
 * (`config.kinds`, matched against each case's `metadata.kind`): a model that cannot take every
 * kind of case in a suite runs only its own. No `kinds` means every case.
 */
export async function suiteLabels(suite: string): Promise<Map<string, string[] | null>> {
  const text = await Bun.file(join(SUITES_DIR, suite, 'promptfooconfig.yaml')).text()
  const config = Bun.YAML.parse(text) as { providers: { label: string; config?: { kinds?: string[] } }[] }
  return new Map(config.providers.map((p) => [p.label, p.config?.kinds ?? null] as const))
}

// ---- the plan ------------------------------------------------------------------

export interface PlanRow {
  model: ModelEntry
  /** The selected suites that list this model. */
  suites: string[]
  need: Requirement
  status: FitStatus
  /** Share of the machine's budget the need takes. */
  ratio: number | null
  /** Why it will not run here, or null when it will. */
  skip: string | null
}

export interface Plan {
  machine: MachineInfo
  profile: { profile: Profile | null; how: string }
  selection: { suites: string[]; categories: string[]; cost: string; models: string }
  force: boolean
  labels: Map<string, Map<string, string[] | null>>
  rows: PlanRow[]
}

export async function buildPlan(opts: {
  machine: Machine
  selection: Selection
  profile?: string | undefined
  force?: boolean | undefined
  /** Skip a model for a reason of the caller's (run.ts: mflux not installed). */
  extraSkip?: (m: ModelEntry) => string | null
}): Promise<Plan> {
  const machine = describe(opts.machine)
  const chosen = chooseProfile(opts.machine, opts.profile)
  const p = chosen.profile
  const sel = opts.selection
  const categories = sel.categories ?? (p?.categories ? new Set<string>(p.categories) : undefined)
  const cost = sel.cost ?? p?.cost
  const onlySuites = sel.suites ?? (p?.suites ? new Set(p.suites) : undefined)
  const onlyModels = sel.models ?? (p?.models ? new Set(p.models) : undefined)
  const dropModels = sel.models ? new Set<string>() : new Set(p?.skip_models ?? [])

  const suites = readdirSync(SUITES_DIR)
    .sort()
    .filter((s) => !onlySuites || onlySuites.has(s))
    .filter((s) => !categories || metaOf(s).categories.some((c) => categories.has(c)))
    .filter((s) => !cost || metaOf(s).cost === cost)
  const labels = new Map(await Promise.all(suites.map(async (s) => [s, await suiteLabels(s)] as const)))
  const view = latest()
  const rows: PlanRow[] = []
  for (const model of MODELS) {
    if (onlyModels && !onlyModels.has(model.label)) continue
    if (dropModels.has(model.label)) continue
    const mine = suites.filter((s) => labels.get(s)!.has(model.label))
    if (mine.length === 0) continue
    const need = requirementOf(model.label, view, machine.class, mine)
    const { status, ratio } = fitOf(need, machine.budget_gib, machine.spill_gib, ranOn(model.label, view, machine.key))
    const skip =
      skipReason(model) ??
      opts.extraSkip?.(model) ??
      (status === 'wont' && !opts.force ? `will not fit: needs ${need.gib!.toFixed(1)} GiB, more than even CPU offload allows here (${machine.spill_gib.toFixed(1)} GiB; accelerator budget ${machine.budget_gib.toFixed(1)} GiB). --force to run it anyway` : null)
    rows.push({ model, suites: mine, need, status, ratio, skip })
  }
  return {
    machine,
    profile: chosen,
    selection: {
      suites,
      categories: categories ? [...categories] : [],
      cost: cost ?? 'any',
      models: onlyModels ? [...onlyModels].join(',') : 'all',
    },
    force: opts.force ?? false,
    labels,
    rows,
  }
}

const gib = (n: number | null) => (n === null ? '?' : `${n.toFixed(1)} GiB`)

/** Prints the plan: the machine, the selection, one line per model with its fit, and loud warnings. */
export function printPlan(plan: Plan): void {
  const m = plan.machine
  const out = console.log
  out(`Machine   ${m.key} · ${m.chip}${m.gpu ? ` + ${m.gpu}` : ''} · class ${m.class} · model memory budget ${gib(m.budget_gib)} of ${m.mem_gib} GiB, CPU offload up to ${gib(m.spill_gib)}`)
  const p = plan.profile.profile
  out(`Profile   ${p ? `${p.name} (${plan.profile.how})` : `none (${plan.profile.how}): everything that fits`}`)
  out(`Selected  ${plan.selection.suites.length} suites${plan.selection.categories.length ? ` in ${plan.selection.categories.join('+')}` : ''}${plan.selection.cost === 'any' ? '' : `, ${plan.selection.cost} only`}; models ${plan.selection.models}`)
  const width = Math.max(5, ...plan.rows.map((r) => r.model.label.length))
  out(`\n${'model'.padEnd(width)}  ${'need'.padStart(9)}  ${'of budget'.padStart(9)}  fit      basis`)
  for (const r of plan.rows) {
    const verdict = r.skip ? (r.status === 'wont' ? 'WON\'T FIT' : 'skip') : r.status === 'wont' ? 'forced' : r.status === 'offload' ? 'OFFLOAD' : r.status
    out(`${r.model.label.padEnd(width)}  ${gib(r.need.gib).padStart(9)}  ${(r.ratio === null ? '?' : `${Math.round(r.ratio * 100)}%`).padStart(9)}  ${verdict.padEnd(8)} ${r.need.note} · ${r.suites.length} suite${r.suites.length === 1 ? '' : 's'}${r.skip && r.status !== 'wont' ? ` · skipped: ${r.skip}` : ''}`)
  }
  const wont = plan.rows.filter((r) => r.status === 'wont')
  const tight = plan.rows.filter((r) => r.status === 'tight')
  const offload = plan.rows.filter((r) => r.status === 'offload')
  const unknown = plan.rows.filter((r) => r.status === 'unknown')
  const skipped = plan.rows.filter((r) => r.skip)
  out(`\n${plan.rows.length - skipped.length} to run, ${skipped.length} skipped (${wont.length} won't fit, ${skipped.length - (plan.force ? 0 : wont.length)} other), ${tight.length} tight, ${offload.length} offload, ${unknown.length} unknown`)
  if (wont.length > 0) {
    out(`\n!!! WON'T FIT on ${m.class}: ${wont.map((r) => `${r.model.label} (${gib(r.need.gib)})`).join(', ')}`)
    out(plan.force ? '!!! --force given: they run anyway; expect swapping, failures or hangs.' : '!!! Skipped. Pass --force to run them anyway, or run them on a larger machine.')
  }
  if (offload.length > 0) out(`\n!! OFFLOAD (over the ${gib(m.budget_gib)} accelerator budget; ${gib(m.spill_gib)} usable memory, or already run here): ${offload.map((r) => `${r.model.label} (${gib(r.need.gib)})`).join(', ')}. They run with layers on the CPU: slower, and their speed and memory numbers are NOT comparable with models that fit.`)
  if (tight.length > 0) out(`\n!! TIGHT (over ${Math.round(TIGHT * 100)}% of the budget): ${tight.map((r) => `${r.model.label} (${Math.round(r.ratio! * 100)}%)`).join(', ')}. Close other programs; memory and speed numbers may reflect swapping.`)
  if (unknown.length > 0) out(`\n!! UNKNOWN memory need (never measured, no catalogue size): ${unknown.map((r) => r.model.label).join(', ')}. They run, and the first run measures them.`)
}
