// Will a model fit? How much memory a model needs, and whether that fits a budget.
//
// The need of a model comes from, in order:
//
// 1. What was measured, in the ledger: Ollama's loaded size (`loaded_bytes`)
//    plus any in-process memory (`rss_mb`, or the image editor's `peak_mb`).
//    Taken as the maximum across the suites the model ran, because a model
//    inside a quality suite uses more than the perf suite's load. In the perf
//    suite only the 8K-context case counts (the 32K cases measure a context
//    most uses never reach). In any other suite it is the peak over the suite's
//    requests, not a median: with images Ollama's reported size ramps up
//    request by request (docs/plans/machines.md, "Why in-suite memory is higher"),
//    so a median would only say how far along the ramp the middle request was.
//    The context length the reading was taken at is kept (`ctx`) and named in
//    the note. `rss_mb` is the whole process, an upper bound.
// 2. The catalogue's download size (`disk_gb`) times a factor for what a
//    loaded model adds to its weights (CATALOG_FACTOR).
// 3. Unknown.
//
// A need is compared with the accelerator's budget in GiB: `fits` up to TIGHT of
// it, `tight` up to the budget itself (little left for the OS, the context or a
// second model). Above the budget but within `spill` (usable system memory: RAM
// minus an OS reserve on unified memory, VRAM plus 60% of RAM on a discrete
// GPU) it is `offload`: Ollama puts the rest on the CPU, so it runs, slower, and
// its timings are not comparable. Beyond that it `wont` run. A model that has a
// result on this very machine is never `wont`: it demonstrably ran.
import { CATALOG } from './catalog.ts'
import { MODELS } from './models.ts'
import type { Latest } from './ledger.ts'
import { describe } from './machine.ts'
import { readSnapshot } from './ledger.ts'

const GIB = 2 ** 30

/**
 * Loaded size over download size, by how the model is run. Ollama adds the
 * context's cache and buffers to the weights (~25% at 8K); an in-process
 * model adds the runtime, activations and image buffers; mflux adds the
 * text encoder and activations; a model with no weights adds nothing.
 */
export const CATALOG_FACTOR = { ollama: 1.25, onnx: 1.5, mflux: 1.5, local: 1 } as const

/** A need above this share of the budget is "tight". */
export const TIGHT = 0.8

export interface Requirement {
  gib: number | null
  basis: 'measured' | 'catalogue' | 'unknown'
  /** Where the number came from, in a few words. */
  note: string
  /** The context window (tokens) the reading was taken at, when known. */
  ctx?: number | null
}

export type FitStatus = 'fits' | 'tight' | 'offload' | 'wont' | 'unknown'

const median = (xs: number[]): number | null => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b)
  return s.length === 0 ? null : s[Math.floor((s.length - 1) / 2)]!
}

/**
 * The context window a suite's Ollama requests use when neither the record nor the suite's config for the
 * model sets one: the provider's own default (providers/ollama-sensitive.ts). Suites absent here ask Ollama
 * for its default, so the context is unknown.
 */
const PROVIDER_DEFAULT_CTX: Record<string, number> = { sensitive: 4096 }

/** The context window a suite's records for a model ran at: recorded by the provider (perf), else the config's `num_ctx`, else the provider default. */
export function contextOf(v: Latest): number | null {
  const r = v.records[0]
  if (!r) return null
  const recorded = r.metrics?.['num_ctx']
  if (recorded !== undefined && Number.isFinite(recorded)) return recorded
  const configured = (readSnapshot(r.suite, r.suite_fp)?.setup as { providers?: { label?: string; config?: { num_ctx?: number; llm?: { num_ctx?: number } } }[] } | undefined)?.providers?.find(
    (p) => p.label === r.model.label,
  )?.config
  return configured?.num_ctx ?? configured?.llm?.num_ctx ?? PROVIDER_DEFAULT_CTX[v.suite] ?? null
}

/** Memory one suite's latest records show for a model, GiB, with the reading's name; null when it recorded none. */
export function suiteNeed(v: Latest): { gib: number; from: string; ctx: number | null; requests: number } | null {
  const metric = (key: string) => v.records.flatMap((r) => (r.metrics?.[key] !== undefined && Number.isFinite(r.metrics[key]) ? [r.metrics[key]!] : []))
  let loaded: number | null
  let ctx: number | null = null
  if (v.suite.startsWith('perf')) {
    const byCase = new Map<string, number[]>()
    for (const r of v.records) if (r.metrics?.['loaded_bytes'] !== undefined) byCase.set(r.case, [...(byCase.get(r.case) ?? []), r.metrics['loaded_bytes']])
    const picked = byCase.has('ctx-8k') ? 'ctx-8k' : [...byCase].sort((a, b) => (median(a[1]) ?? 0) - (median(b[1]) ?? 0))[0]?.[0]
    loaded = picked === undefined ? null : median(byCase.get(picked)!)
    // The perf provider records the window each row ran at; the picked row's is the reading's context.
    ctx = median(v.records.filter((r) => r.case === picked).flatMap((r) => (r.metrics?.['num_ctx'] !== undefined ? [r.metrics['num_ctx']] : [])))
  } else {
    const all = metric('loaded_bytes')
    loaded = all.length > 0 ? Math.max(...all) : null
    ctx = loaded ? contextOf(v) : null
  }
  const inproc = Math.max(0, ...metric('rss_mb'), ...metric('peak_mb')) * 2 ** 20
  const bytes = (loaded ?? 0) + inproc
  if (!(bytes > 0)) return null
  if (!loaded) ctx = null
  const peak = !v.suite.startsWith('perf') && loaded ? ' peak' : ''
  return {
    gib: bytes / GIB,
    from: `${v.suite}${loaded ? ` loaded${peak}${ctx ? ` at ${ctx / 1024}K context` : ''}` : ''}${inproc ? ' rss/peak' : ''}`,
    ctx,
    requests: metric('loaded_bytes').length,
  }
}

/**
 * What a model needs. Measurements from machines of `preferClass` win when
 * there are any (a card's VRAM use differs from a Mac's unified memory),
 * otherwise any machine's are used. With `suites`, the readings of those
 * suites only, if any of them has one.
 */
export function requirementOf(label: string, view: Latest[], preferClass?: string, suites?: string[]): Requirement {
  const all = view.filter((v) => v.model === label)
  // Only the suites about to run count when any of them was measured; otherwise the model's largest reading anywhere.
  const scoped = suites ? all.filter((v) => suites.includes(v.suite)) : all
  const mine = scoped.some((v) => suiteNeed(v)) ? scoped : all
  const same = mine.filter((v) => v.records[0] && preferClass && describe(v.records[0].machine).class === preferClass)
  const needs = (same.length > 0 ? same : mine).flatMap((v) => suiteNeed(v) ?? [])
  if (needs.length > 0) {
    const top = needs.reduce((a, b) => (b.gib > a.gib ? b : a))
    return { gib: top.gib, basis: 'measured', ctx: top.ctx, note: `measured, ${top.from}${same.length === 0 && preferClass && mine.length > 0 ? ' (on another class of machine)' : ''}` }
  }
  const entry = MODELS.find((m) => m.label === label)
  const disk = CATALOG[label]?.disk_gb
  if (entry && disk) {
    const factor = CATALOG_FACTOR[entry.runtime ?? 'ollama']
    return { gib: (disk * 1e9 * factor) / GIB, basis: 'catalogue', note: `catalogue ${disk} GB × ${factor}` }
  }
  return { gib: null, basis: 'unknown', note: 'never run here and no catalogue size' }
}

export function fitOf(need: Requirement, budgetGib: number, spillGib: number, ranHere = false): { status: FitStatus; ratio: number | null } {
  if (need.gib === null || !(budgetGib > 0)) return { status: 'unknown', ratio: null }
  const ratio = need.gib / budgetGib
  const status: FitStatus = ratio <= TIGHT ? 'fits' : ratio <= 1 ? 'tight' : need.gib <= spillGib || ranHere ? 'offload' : 'wont'
  return { status, ratio }
}

/** Whether the model has results on this machine (key): it ran there, whatever its memory reading says. */
export const ranOn = (label: string, view: Latest[], machineKey: string): boolean => view.some((v) => v.model === label && v.machine === machineKey)
