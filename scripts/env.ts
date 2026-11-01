// What a run ran on, frozen like suite snapshots so ledger records can name
// it by hash:
//
// - results/environments/<hash>.json: hardware, OS, GPU budget, and the
//   runtime (Ollama version and server settings, promptfoo, Bun, Node).
// - results/models/<digest>.json: one model build as Ollama reports it:
//   engine (llama.cpp or MLX), format, quantization, parameters, context
//   length, capabilities and default sampling parameters.
//
// Both are written once and never edited; scripts/check.ts verifies.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnRunner } from '@osdlc/command-seam'
import { OLLAMA, PROMPTFOO_VERSION, ROOT, machine } from './ledger.ts'

export const ENV_DIR = join(ROOT, 'results', 'environments')
export const MODEL_DIR = join(ROOT, 'results', 'models')

/**
 * Ollama server settings that change speed, memory or output. Read from the
 * newest "server config" line in Ollama's log, which records the effective
 * value of every setting at startup. Paths and network settings are left out.
 */
const OLLAMA_SETTINGS = [
  'OLLAMA_CONTEXT_LENGTH',
  'OLLAMA_FLASH_ATTENTION',
  'OLLAMA_KV_CACHE_TYPE',
  'OLLAMA_KEEP_ALIVE',
  'OLLAMA_MAX_LOADED_MODELS',
  'OLLAMA_NUM_PARALLEL',
  'OLLAMA_GPU_OVERHEAD',
  'OLLAMA_NEW_ENGINE',
  'OLLAMA_SCHED_SPREAD',
  'OLLAMA_MULTIUSER_CACHE',
  'OLLAMA_LLM_LIBRARY',
  'OLLAMA_LOAD_TIMEOUT',
]

export interface Environment {
  hardware: {
    key: string
    chip: string
    hw_model: string
    mem_gib: number
    cpu_performance_cores: number
    cpu_efficiency_cores: number
    gpu_cores: number
    /** Metal's recommendedMaxWorkingSetSize: the GPU memory budget, in MiB. */
    gpu_budget_mib: number
    /** iogpu.wired_limit_mb; 0 means the macOS default. */
    gpu_wired_limit_mb: number
  }
  os: { name: string; version: string; build: string; kernel: string }
  power: string
  runtime: {
    ollama: string
    /** When the Ollama server whose settings these are started. */
    ollama_started: string | null
    ollama_settings: Record<string, string>
    promptfoo: string
    bun: string
    node: string
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12)

function ollamaSettings(): { started: string | null; settings: Record<string, string> } {
  const logs = join(homedir(), '.ollama', 'logs')
  if (!existsSync(logs)) return { started: null, settings: {} }
  const line = readdirSync(logs)
    .filter((f) => f.startsWith('server') && f.endsWith('.log'))
    .flatMap((f) => readFileSync(join(logs, f), 'utf8').split('\n'))
    .filter((l) => l.includes('msg="server config"'))
    .sort()
    .at(-1)
  if (!line) return { started: null, settings: {} }
  const settings: Record<string, string> = {}
  for (const key of OLLAMA_SETTINGS) {
    const m = new RegExp(`${key}:(\\S*)`).exec(line)
    if (m) settings[key] = m[1]!
  }
  return { started: /time=(\S+)/.exec(line)?.[1] ?? null, settings }
}

export async function captureEnvironment(): Promise<Environment> {
  const run = (bin: string, args: string[]) => spawnRunner(bin).run(args, { cwd: ROOT }).stdout.trim()
  const sysctl = (name: string) => run('sysctl', ['-n', name])
  const gpu = JSON.parse(run('system_profiler', ['SPDisplaysDataType', '-json']) || '{}') as {
    SPDisplaysDataType?: { sppci_cores?: string }[]
  }
  const budget = Number(run('swift', [join(ROOT, 'scripts', 'metal-working-set.swift')]))
  const { version } = (await (await fetch(`${OLLAMA}/api/version`)).json()) as { version: string }
  const ollama = ollamaSettings()
  return {
    hardware: {
      ...machine(),
      cpu_performance_cores: Number(sysctl('hw.perflevel0.physicalcpu')),
      cpu_efficiency_cores: Number(sysctl('hw.perflevel1.physicalcpu')),
      gpu_cores: Number(gpu.SPDisplaysDataType?.[0]?.sppci_cores ?? 0),
      gpu_budget_mib: Math.round(budget / 2 ** 20),
      gpu_wired_limit_mb: Number(sysctl('iogpu.wired_limit_mb') || 0),
    },
    os: {
      name: run('sw_vers', ['-productName']),
      version: run('sw_vers', ['-productVersion']),
      build: run('sw_vers', ['-buildVersion']),
      kernel: run('uname', ['-r']),
    },
    power: /'([^']+)'/.exec(run('pmset', ['-g', 'ps']))?.[1] ?? 'unknown',
    runtime: {
      ollama: version,
      ollama_started: ollama.started,
      ollama_settings: ollama.settings,
      promptfoo: PROMPTFOO_VERSION,
      bun: Bun.version,
      node: run('node', ['--version']),
    },
  }
}

/** Writes the environment once, by content hash, and returns the hash. */
export function freezeEnvironment(env: Environment): string {
  const text = `${JSON.stringify(env, null, 2)}\n`
  const hash = sha(text)
  const path = join(ENV_DIR, `${hash}.json`)
  if (!existsSync(path)) {
    mkdirSync(ENV_DIR, { recursive: true })
    writeFileSync(path, text)
  }
  return hash
}

export interface ModelInfo {
  tag: string
  digest: string
  /** `mlx` or `default` (llama.cpp / GGML), as Ollama reports it. */
  engine: string
  format: string
  family: string
  quantization: string
  parameter_size: string
  parameter_count: number | null
  context_length: number | null
  capabilities: string[]
  /** The model's default sampling parameters, which a suite may override. */
  default_parameters: Record<string, string>
  template_hash: string
}

/** Writes an ONNX model's details once, keyed by its pinned revision. */
export function freezeOnnxModel(id: string, revision: string, dtype: string): void {
  const digest = revision.slice(0, 12)
  const path = join(MODEL_DIR, `${digest}.json`)
  if (existsSync(path)) return
  const model: ModelInfo = {
    tag: id,
    digest,
    engine: 'transformers.js (onnxruntime)',
    format: 'onnx',
    family: '',
    quantization: dtype,
    parameter_size: '',
    parameter_count: null,
    context_length: null,
    capabilities: ['image-classification'],
    default_parameters: { revision },
    template_hash: '',
  }
  mkdirSync(MODEL_DIR, { recursive: true })
  writeFileSync(path, `${JSON.stringify(model, null, 2)}\n`)
}

/** Writes a model build's details once, keyed by its digest. */
export async function freezeModel(tag: string, digest: string): Promise<void> {
  const path = join(MODEL_DIR, `${digest}.json`)
  if (existsSync(path)) return
  const show = (await (
    await fetch(`${OLLAMA}/api/show`, { method: 'POST', body: JSON.stringify({ model: tag }) })
  ).json()) as {
    details: Record<string, string>
    capabilities?: string[]
    model_info?: Record<string, unknown>
    parameters?: string
    template?: string
  }
  const info = show.model_info ?? {}
  const arch = String(info['general.architecture'] ?? '')
  const model: ModelInfo = {
    tag,
    digest,
    engine: show.details['runner'] ?? 'default',
    format: show.details['format'] ?? '',
    family: show.details['family'] ?? '',
    quantization: show.details['quantization_level'] ?? '',
    parameter_size: show.details['parameter_size'] ?? '',
    parameter_count: typeof info['general.parameter_count'] === 'number' ? info['general.parameter_count'] : null,
    context_length: typeof info[`${arch}.context_length`] === 'number' ? (info[`${arch}.context_length`] as number) : null,
    capabilities: show.capabilities ?? [],
    default_parameters: Object.fromEntries(
      (show.parameters ?? '')
        .split('\n')
        .map((l) => l.trim().split(/\s+/))
        .filter((p) => p.length >= 2)
        .map(([k, ...v]) => [k!, v.join(' ')]),
    ),
    template_hash: sha(show.template ?? ''),
  }
  mkdirSync(MODEL_DIR, { recursive: true })
  writeFileSync(path, `${JSON.stringify(model, null, 2)}\n`)
}
