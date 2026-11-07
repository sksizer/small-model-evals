// Will a model fit? How much memory a model needs, and whether that fits a budget.
//
// The need of a model comes from, in order:
//
// 1. What was measured, in the ledger: Ollama's loaded size (`loaded_bytes`)
//    plus any in-process memory (`rss_mb`, or the image editor's `peak_mb`).
//    Taken as the maximum across the suites the model ran, because a model
//    inside a quality suite uses more than the perf suite's load. In the perf
//    suite only the 8K-context case counts (the 32K cases measure a context
//    most uses never reach). `rss_mb` is the whole process, an upper bound.
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
}

export type FitStatus = 'fits' | 'tight' | 'offload' | 'wont' | 'unknown'

const median = (xs: number[]): number | null => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b)
  return s.length === 0 ? null : s[Math.floor((s.length - 1) / 2)]!
}

/** Memory one suite's latest records show for a model, GiB, with the reading's name; null when it recorded none. */
function suiteNeed(v: Latest): { gib: number; from: string } | null {
  const metric = (key: string) => v.records.flatMap((r) => (r.metrics?.[key] !== undefined && Number.isFinite(r.metrics[key]) ? [r.metrics[key]!] : []))
  let loaded: number | null
  if (v.suite.startsWith('perf')) {
    const byCase = new Map<string, number[]>()
    for (const r of v.records) if (r.metrics?.['loaded_bytes'] !== undefined) byCase.set(r.case, [...(byCase.get(r.case) ?? []), r.metrics['loaded_bytes']])
    const pick = byCase.get('ctx-8k') ?? [...byCase.values()].sort((a, b) => (median(a) ?? 0) - (median(b) ?? 0))[0]
    loaded = pick ? median(pick) : null
  } else loaded = median(metric('loaded_bytes'))
  const inproc = Math.max(0, ...metric('rss_mb'), ...metric('peak_mb')) * 2 ** 20
  const bytes = (loaded ?? 0) + inproc
  return bytes > 0 ? { gib: bytes / GIB, from: `${v.suite}${loaded ? ' loaded' : ''}${inproc ? ' rss/peak' : ''}` } : null
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
    return { gib: top.gib, basis: 'measured', note: `measured, ${top.from}${same.length === 0 && preferClass && mine.length > 0 ? ' (on another class of machine)' : ''}` }
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
