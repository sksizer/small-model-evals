// Which machine a run is on, and which class of machine that is.
//
// A machine has a `key` (hardware model plus memory: it groups results and
// names no person or host) and a `class` (accelerator family plus a memory
// tier: `apple-16g`, `nvidia-24g`, `cpu-32g`), which says what size of model
// it can run. Results are grouped per key; the class is what a reader of the
// site uses to ask "would this fit on my machine?".
//
// Detection works on macOS (Apple silicon and Intel), Linux and Windows (with
// NVIDIA via `nvidia-smi` when present) and fails soft: anything it cannot
// read falls back to a CPU-only machine of the memory the OS reports.
//
// Old ledger records carry only key, chip, hw_model and mem_gib; `describe`
// derives the rest from those at read time, so the ledger is never rewritten.
import { spawnRunner } from '@osdlc/command-seam'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

const GIB = 2 ** 30

/** Trimmed stdout of a command, or '' when it is missing or fails. Never throws. */
export function sh(bin: string, args: string[]): string {
  try {
    const r = spawnRunner(bin).run(args, { cwd: process.cwd(), timeoutMs: 20_000 })
    return r.exitCode === 0 ? r.stdout.trim() : ''
  } catch {
    return ''
  }
}

export type Accel = 'apple' | 'nvidia' | 'cpu'

/** Memory the OS and other programs keep when a model spills past the accelerator into system RAM. */
export const OS_RESERVE_GIB = 3
/** The share of system RAM Ollama may use for layers that do not fit a discrete GPU's VRAM. */
export const SPILL_SHARE = 0.6
/** Host RAM assumed for a class of discrete GPU, whose host is not known (a typical 32 GiB). */
export const TYPICAL_HOST_GIB = 32

/**
 * The memory tiers, the one place they are defined. A machine is in the
 * largest tier it fully meets, by the memory a model actually lives in:
 *
 * - apple: installed unified memory (CPU and GPU share it; Metal lets the GPU
 *   use about three quarters of it, two thirds on 8 GB).
 * - nvidia: the card's VRAM, since a model that spills out of it runs several
 *   times slower. Rounded to whole GiB, so a 24 GB card that reports 23.99
 *   GiB is still `nvidia-24g`.
 * - cpu: installed RAM; weights are mapped from RAM and the OS and other
 *   programs need room, so only about 60% counts as the budget.
 *
 * The top tier is open-ended and written with a `+` (`apple-64g+`).
 * `spill` is the most a model may need and still run by offloading layers
 * to the CPU, slower and with timings not comparable: unified memory minus
 * an OS reserve (Apple, CPU), or VRAM plus 60% of system RAM (NVIDIA).
 * `usable` is the fraction of a tier's memory that models may fill: the
 * nominal budget used to compare classes. A real machine's own budget is
 * measured where the OS reports one (Metal's working set, VRAM).
 */
export const TIERS: Record<Accel, { tiers: number[]; usable: (tier: number) => number; spill: (tier: number) => number }> = {
  apple: { tiers: [8, 16, 24, 32, 48, 64], usable: (t) => t * (t <= 8 ? 0.67 : 0.75), spill: (t) => t - OS_RESERVE_GIB },
  nvidia: { tiers: [4, 6, 8, 12, 16, 24, 32, 48], usable: (t) => t * 0.95, spill: (t) => t + SPILL_SHARE * TYPICAL_HOST_GIB },
  cpu: { tiers: [4, 8, 16, 32, 64], usable: (t) => t * 0.6, spill: (t) => t - OS_RESERVE_GIB },
}

/** The class of a machine with this accelerator and this much model memory (GiB). */
export function classFor(accel: Accel, memGib: number): string {
  const { tiers } = TIERS[accel]
  const tier = [...tiers].reverse().find((t) => t <= Math.round(memGib)) ?? tiers[0]!
  return `${accel}-${tier}g${tier === tiers.at(-1) ? '+' : ''}`
}

/** Accelerator and tier memory (GiB) of a class name; null when it is not one of ours. */
export function parseClass(cls: string): { accel: Accel; tier: number } | null {
  const m = /^(apple|nvidia|cpu)-(\d+)g\+?$/.exec(cls)
  return m ? { accel: m[1] as Accel, tier: Number(m[2]) } : null
}

/** Nominal usable model memory of a class, in GiB. */
export function classBudgetGib(cls: string): number {
  const p = parseClass(cls)
  return p ? TIERS[p.accel].usable(p.tier) : 0
}

/** Largest need that still runs by CPU offload, GiB, for a class's nominal machine. */
export function classSpillGib(cls: string): number {
  const p = parseClass(cls)
  return p ? TIERS[p.accel].spill(p.tier) : 0
}

/** The same for a real machine, from its real memory. */
export function spillGib(accel: Accel, memGib: number, vramGib: number | null): number {
  return accel === 'nvidia' ? (vramGib ?? 0) + SPILL_SHARE * memGib : memGib - OS_RESERVE_GIB
}

/** Every class, smallest to largest within each accelerator, for pickers. */
export const ALL_CLASSES: { class: string; accel: Accel; budget_gib: number; spill_gib: number }[] = (Object.keys(TIERS) as Accel[]).flatMap((accel) =>
  TIERS[accel].tiers.map((t) => {
    const cls = classFor(accel, t)
    return { class: cls, accel, budget_gib: classBudgetGib(cls), spill_gib: classSpillGib(cls) }
  }),
)

/** What identifies a machine. Exactly what old ledger records carry. */
export interface MachineId {
  /** Hardware model and memory, e.g. `Mac16,10-16g`. Groups results; names no person or host. */
  key: string
  chip: string
  hw_model: string
  /** Installed system memory. */
  mem_gib: number
}

/** A machine as stored on a record: the identity, plus the fields records have carried since machine classes. */
export interface Machine extends MachineId {
  accel?: Accel
  gpu?: string | null
  vram_gib?: number | null
  /** Memory models may fill, GiB: Metal's working set, a GPU's VRAM, or a share of RAM. */
  budget_gib?: number
  /** Most a model may need and still run by CPU offload (see TIERS). */
  spill_gib?: number
  class?: string
}

/** A machine with everything derived. */
export interface MachineInfo extends MachineId {
  accel: Accel
  gpu: string | null
  vram_gib: number | null
  budget_gib: number
  spill_gib: number
  class: string
}

/** Fills in what an old record lacks, from the fields it has. Apple silicon is told by its chip name; an Intel Mac or anything else is CPU-only. */
export function describe(m: Machine): MachineInfo {
  const accel = m.accel ?? (m.chip.startsWith('Apple') ? 'apple' : 'cpu')
  const vram = m.vram_gib ?? null
  const mem = accel === 'nvidia' ? (vram ?? m.mem_gib) : m.mem_gib
  const cls = m.class ?? classFor(accel, mem)
  return { ...m, accel, gpu: m.gpu ?? null, vram_gib: vram, budget_gib: m.budget_gib ?? classBudgetGib(cls), spill_gib: m.spill_gib ?? spillGib(accel, m.mem_gib, vram), class: cls }
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/\((r|tm)\)|\b(cpu|processor|graphics)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28)

let metal: number | null | undefined
/** Metal's recommendedMaxWorkingSetSize in GiB (scripts/metal-working-set.swift), or null when swift cannot say. */
export function metalBudgetGib(): number | null {
  if (metal === undefined) {
    const bytes = Number(sh('swift', [join(import.meta.dir, 'metal-working-set.swift')]))
    metal = bytes > 0 ? bytes / GIB : null
  }
  return metal
}

/** The NVIDIA card with the most memory, from nvidia-smi; null when there is none or the tool is absent. */
export function nvidia(): { name: string; vram_gib: number; driver: string; cuda: string | null } | null {
  const out = sh('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'])
  const cards = out
    .split('\n')
    .map((l) => l.split(',').map((x) => x.trim()))
    .filter((p) => p.length >= 3 && Number(p[1]) > 0)
    .map((p) => ({ name: p[0]!, vram_gib: Math.round(Number(p[1]) / 1024), driver: p[2]! }))
  if (cards.length === 0) return null
  const best = cards.reduce((a, b) => (b.vram_gib > a.vram_gib ? b : a))
  return { ...best, cuda: /CUDA Version:\s*([\d.]+)/.exec(sh('nvidia-smi', []))?.[1] ?? null }
}

const readOr = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8').trim() : '')

/** Identity and class of this machine. */
export function machine(): MachineInfo {
  const memGib = Math.round(os.totalmem() / GIB)
  if (process.platform === 'darwin') {
    const sysctl = (name: string) => sh('sysctl', ['-n', name])
    const hw = sysctl('hw.model')
    const mem = Math.round(Number(sysctl('hw.memsize')) / GIB) || memGib
    const silicon = sysctl('hw.optional.arm64') === '1'
    const accel: Accel = silicon ? 'apple' : 'cpu'
    const cls = classFor(accel, mem)
    return {
      key: `${hw}-${mem}g`,
      chip: sysctl('machdep.cpu.brand_string'),
      hw_model: hw,
      mem_gib: mem,
      accel,
      gpu: null,
      vram_gib: null,
      budget_gib: (silicon ? metalBudgetGib() : null) ?? classBudgetGib(cls),
      spill_gib: spillGib(accel, mem, null),
      class: cls,
    }
  }
  const chip = /^model name\s*:\s*(.+)$/m.exec(readOr('/proc/cpuinfo'))?.[1]?.trim() ?? os.cpus()[0]?.model ?? process.arch
  const product = readOr('/sys/class/dmi/id/product_name')
  const hw = product && !/^(to be filled|default string|system product)/i.test(product) ? product.replace(/\s+/g, '-') : `${process.platform}-${slug(chip) || process.arch}`
  const gpu = nvidia()
  const accel: Accel = gpu ? 'nvidia' : 'cpu'
  const cls = classFor(accel, gpu ? gpu.vram_gib : memGib)
  return {
    key: gpu ? `${hw}-${slug(gpu.name)}-${memGib}g` : `${hw}-${memGib}g`,
    chip,
    hw_model: hw,
    mem_gib: memGib,
    accel,
    gpu: gpu?.name ?? null,
    vram_gib: gpu?.vram_gib ?? null,
    budget_gib: classBudgetGib(cls),
    spill_gib: spillGib(accel, memGib, gpu?.vram_gib ?? null),
    class: cls,
  }
}
