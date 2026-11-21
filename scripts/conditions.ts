// What state the machine was in while a model ran: the load, free memory, swap,
// power and other heavy programs that skew timings and memory readings.
//
// Frozen facts about the machine live in the environment (scripts/env.ts);
// this is the part that changes from run to run. Each `bun scripts/run.ts` run
// writes results/conditions/<run>.json: one entry per (model, suite) eval with
// the conditions sampled just before and just after it. It is a file per run
// rather than a field on every record because a run holds thousands of
// records but a few dozen evals, and the ledger is append-only and already
// large. The site reads these files to flag runs taken under load.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { sh } from './machine.ts'

const GIB = 2 ** 30

export interface Conditions {
  /** 1-minute load average. */
  load_1m: number
  /** Load per logical core: about 1 means every core is busy. */
  load_per_core: number
  /** Memory available without swapping, GiB (macOS counts free, inactive and speculative pages; Linux uses MemAvailable). */
  mem_available_gib: number
  /** macOS only: the share of memory `memory_pressure` calls free, percent. */
  mem_free_pct: number | null
  swap_used_gib: number
  power: 'ac' | 'battery' | 'unknown'
  /** macOS only. */
  low_power_mode: boolean | null
  /** macOS only: the CPU speed limit in percent when the OS is throttling for heat, else null. */
  thermal_limit_pct: number | null
  /** Other programs using a lot of CPU when sampled (this run's own tools are left out). */
  busy: { name: string; cpu_pct: number }[]
}

/** Programs that belong to the eval itself and so are not "something else running". */
const OWN = /^(bun|node|npx|npm|ollama|ollama-runner|runner|mflux.*|python.*|promptfoo|swift.*|ps|sh|zsh|bash|fish)$/i
/** CPU percent (of one core) above which another program counts as busy. */
const BUSY_PCT = 40

const num = (re: RegExp, text: string) => {
  const m = re.exec(text)
  return m ? Number(m[1]) : null
}

function memory(): { available: number; swap: number; freePct: number | null } {
  if (process.platform === 'darwin') {
    const vm = sh('vm_stat', [])
    const page = num(/page size of (\d+) bytes/, vm) ?? 16384
    const pages = (label: string) => num(new RegExp(`${label}:\\s+(\\d+)`), vm) ?? 0
    const available = ((pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable')) * page) / GIB
    const swap = sh('sysctl', ['-n', 'vm.swapusage'])
    return { available, swap: (num(/used = ([\d.]+)M/, swap) ?? 0) / 1024, freePct: num(/free percentage:\s*(\d+)%/, sh('memory_pressure', [])) }
  }
  const info = existsSync('/proc/meminfo') ? readFileSync('/proc/meminfo', 'utf8') : ''
  const kb = (k: string) => num(new RegExp(`${k}:\\s+(\\d+) kB`), info)
  const swapTotal = kb('SwapTotal') ?? 0
  return { available: (kb('MemAvailable') ?? os.freemem() / 1024) / 2 ** 20, swap: (swapTotal - (kb('SwapFree') ?? swapTotal)) / 2 ** 20, freePct: null }
}

function power(): { source: Conditions['power']; lowPower: boolean | null } {
  if (process.platform === 'darwin') {
    const src = /Now drawing from '([^']+)'/.exec(sh('pmset', ['-g', 'ps']))?.[1]
    const low = num(/lowpowermode\s+(\d)/, sh('pmset', ['-g']))
    return { source: src === 'AC Power' ? 'ac' : src ? 'battery' : 'unknown', lowPower: low === null ? null : low === 1 }
  }
  const dir = '/sys/class/power_supply'
  if (!existsSync(dir)) return { source: 'unknown', lowPower: null }
  const supplies = readdirSync(dir)
  const battery = supplies.find((s) => readFileSync(join(dir, s, 'type'), 'utf8').trim() === 'Battery')
  if (!battery) return { source: 'ac', lowPower: null }
  return { source: readFileSync(join(dir, battery, 'status'), 'utf8').trim() === 'Discharging' ? 'battery' : 'ac', lowPower: null }
}

/** The busiest other programs right now, by CPU, all processes of one name added together (a compiler runs many). */
function busy(): Conditions['busy'] {
  const args = process.platform === 'darwin' ? ['-Ao', 'pcpu,comm', '-r'] : ['-Ao', 'pcpu,comm', '--sort=-pcpu']
  const byName = new Map<string, number>()
  for (const l of sh('ps', args).split('\n').slice(1)) {
    const m = /^\s*([\d.]+)\s+(.+)$/.exec(l)
    const name = m?.[2]?.split('/').at(-1)?.trim()
    if (m && name && !OWN.test(name)) byName.set(name, (byName.get(name) ?? 0) + Number(m[1]))
  }
  return [...byName]
    .filter(([, pct]) => pct >= BUSY_PCT)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, pct]) => ({ name, cpu_pct: Math.round(pct) }))
}

export function sample(): Conditions {
  const cores = os.cpus().length || 1
  const load = os.loadavg()[0] ?? 0
  const mem = memory()
  const p = power()
  const limit = process.platform === 'darwin' ? num(/CPU_Speed_Limit\s*=\s*(\d+)/, sh('pmset', ['-g', 'therm'])) : null
  return {
    load_1m: Math.round(load * 100) / 100,
    load_per_core: Math.round((load / cores) * 100) / 100,
    mem_available_gib: Math.round(mem.available * 10) / 10,
    mem_free_pct: mem.freePct,
    swap_used_gib: Math.round(mem.swap * 10) / 10,
    power: p.source,
    low_power_mode: p.lowPower,
    thermal_limit_pct: limit !== null && limit < 100 ? limit : null,
    busy: busy(),
  }
}

/** Thresholds for "this skews the numbers"; one place so the runner and the site agree. */
export const LIMITS = { load_per_core: 0.5, mem_available_gib: 3, mem_free_pct: 25, swap_used_gib: 2 }

/**
 * Why a sample means timings and memory readings cannot be trusted, in words
 * that say what to do. `load` counts only before a run starts: during one, the
 * load average is mostly the eval's own work.
 */
export function problems(c: Conditions, opts: { load: boolean }): string[] {
  const out: string[] = []
  if (opts.load && c.load_per_core > LIMITS.load_per_core) out.push(`load ${c.load_1m} on the cores (${c.load_per_core}/core): something is working; wait for it or close it`)
  if (c.mem_available_gib < LIMITS.mem_available_gib || (c.mem_free_pct !== null && c.mem_free_pct < LIMITS.mem_free_pct)) {
    out.push(`little free memory (${c.mem_available_gib} GiB available${c.mem_free_pct === null ? '' : `, ${c.mem_free_pct}% free`}): close browsers, editors and VMs`)
  }
  if (c.swap_used_gib > LIMITS.swap_used_gib) out.push(`${c.swap_used_gib} GiB of swap in use: memory is already over-committed; restart apps that hold a lot`)
  if (c.power === 'battery') out.push('on battery: plug in, or the machine may throttle')
  if (c.low_power_mode) out.push('Low Power Mode is on: turn it off')
  if (c.thermal_limit_pct !== null) out.push(`thermal throttling (CPU limited to ${c.thermal_limit_pct}%): let it cool`)
  for (const b of c.busy) out.push(`${b.name} is using ${b.cpu_pct}% of a core: close it if you can`)
  return out
}

/** One (model, suite) eval's conditions. */
export interface EvalConditions {
  model: string
  suite: string
  kind: string | null
  start: Conditions
  end: Conditions
  /** Problems at either end (see `problems`), empty for a clean eval. */
  flags: string[]
}

export interface RunConditions {
  run: string
  evals: EvalConditions[]
}

export const conditionsFile = (dir: string, run: string) => join(dir, `${run}.json`)

/** Samples before an eval; call `finish` after it to get the entry. `first` makes the load average count, since only the first eval starts on an idle machine. */
export function begin(model: string, suite: string, kind: string | null, first: boolean): () => EvalConditions {
  const start = sample()
  return () => {
    const end = sample()
    const flags = [...new Set([...problems(start, { load: first }), ...problems(end, { load: false })])]
    return { model, suite, kind, start, end, flags }
  }
}

export function writeConditions(dir: string, rc: RunConditions): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(conditionsFile(dir, rc.run), `${JSON.stringify(rc, null, 2)}\n`)
}

export function readConditions(dir: string): RunConditions[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as RunConditions)
}
