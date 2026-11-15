// The run loop, as a function: scripts/run.ts (run now) and scripts/queue.ts
// (run a queued job when the machine is free) both call it, so a queued run
// and a hand run take the same path and write the same records.
//
// promptfoo orders work test by test, cycling through the providers inside
// each test, so a suite with six local models would swap models on every
// call: slow, and two can sit in memory at once. This runs one promptfoo
// eval per (model, suite[, kind]) with --filter-providers, unloading before
// each, so exactly one model is loaded and the speed numbers are clean.
//
// promptfoo's raw output lands in results/runs/<timestamp>/ (not committed);
// the records go to results/ledger/. The conditions the machine was in around
// every eval go to results/conditions/<run>.json (scripts/conditions.ts).
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { streamRunner } from '@osdlc/command-seam'
import { begin, writeConditions, type EvalConditions } from './conditions.ts'
import { captureEnvironment, freezeEnvironment, freezeLocalModel, freezeMfluxModel, freezeModel, freezeOnnxModel } from './env.ts'
import { OLLAMA, PROMPTFOO_VERSION, RESULTS_DIR, SUITES_DIR, append, freeze, modelDigests, ollamaVersion, recordsFromPromptfoo } from './ledger.ts'
import { machine } from './machine.ts'
import { mfluxProblem, mfluxWeights } from './mflux.ts'
import type { ModelEntry } from './models.ts'
import { metaOf, type Plan } from './plan.ts'

const PROMPTFOO = `promptfoo@${PROMPTFOO_VERSION}`

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Why a model cannot run here for a reason of the run itself (mflux not installed or its weights missing), or null; pass as buildPlan's `extraSkip`. */
export const runnableProblem = (m: ModelEntry): string | null =>
  m.runtime === 'mflux' ? (mfluxProblem() ?? (existsSync(mfluxWeights(m)) ? null : 'weights missing: run `bun scripts/setup.ts`')) : null

/** One promptfoo eval: a model on a suite, limited to one kind of case when the provider takes several. */
export interface EvalId {
  model: string
  suite: string
  kind: string | null
}

/** The key an eval is recorded under (a queue job's `done` list). */
export const evalKey = (e: EvalId) => `${e.model}·${e.suite}${e.kind ? `·${e.kind}` : ''}`

/** Every eval a plan runs, in order: model by model, each model's suites, each suite's kinds. Skipped models (will not fit, not installed) have none. */
export function evalsOf(plan: Plan, onlyKinds?: Set<string>): EvalId[] {
  const out: EvalId[] = []
  for (const { model, skip, suites } of plan.rows) {
    if (skip) continue
    for (const suite of plan.selection.suites.filter((s) => suites.includes(s))) {
      for (const kind of (plan.labels.get(suite)!.get(model.label) ?? [null]).filter((k) => !onlyKinds || (k !== null && onlyKinds.has(k)))) {
        out.push({ model: model.label, suite, kind })
      }
    }
  }
  return out
}

export async function unloadAll(): Promise<void> {
  const { models } = (await (await fetch(`${OLLAMA}/api/ps`)).json()) as { models: { name: string }[] }
  for (const m of models) {
    // keep_alive 0 unloads; /api/generate works for chat and embedding models.
    await fetch(`${OLLAMA}/api/generate`, { method: 'POST', body: JSON.stringify({ model: m.name, keep_alive: 0 }) })
  }
}

export interface RunOptions {
  plan: Plan
  /** Only the cases of these kinds (a provider's `config.kinds`). */
  onlyKinds?: Set<string> | undefined
  /** Run each case this many times (promptfoo --repeat); the ledger keeps every repeat. */
  repeat?: number | undefined
  /** Evals to leave out, e.g. the ones a resumed queue job already did. */
  skip?: (e: EvalId) => boolean
  /**
   * Awaited before every eval; may take as long as it likes (the queue worker waits here for the machine to be
   * quiet). Return true when it waited: the load average then counts for the next eval's conditions.
   */
  before?: (e: EvalId, index: number) => Promise<boolean | void>
  /** Called after an eval's records are in the ledger. */
  after?: (e: EvalId, run: string) => void | Promise<void>
}

export interface RunResult {
  run: string
  /** The evals that ran to the ledger. */
  done: EvalId[]
  failures: string[]
  conditions: EvalConditions[]
}

export async function runPlan(opts: RunOptions): Promise<RunResult> {
  const { plan } = opts
  const host = machine()
  const run = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outDir = join(RESULTS_DIR, 'runs', run)
  // Freeze each suite before running it: the snapshot is what the records link to.
  const fingerprints = new Map(plan.selection.suites.map((s) => [s, freeze(s)]))
  const ollama = await ollamaVersion()
  const digests = await modelDigests()
  const env = freezeEnvironment(await captureEnvironment())
  const runner = streamRunner('npx')
  const failures: string[] = []
  const conditions: EvalConditions[] = []
  const done: EvalId[] = []
  const frozen = new Set<string>()
  const noted = new Set<string>()

  for (const { model, skip } of plan.rows) {
    if (skip && !noted.has(model.label)) {
      noted.add(model.label)
      console.log(`\n--- skipping ${model.label}: ${skip}`)
    }
  }
  let index = 0
  for (const e of evalsOf(plan, opts.onlyKinds)) {
    if (opts.skip?.(e)) continue
    const model = plan.rows.find((r) => r.model.label === e.model)!.model
    const digest = model.runtime ? model.revision!.slice(0, 12) : digests.get(model.tag)
    if (!digest) {
      if (!failures.some((f) => f.startsWith(`${model.label}: not installed`))) failures.push(`${model.label}: not installed (${model.tag})`)
      continue
    }
    if (!frozen.has(model.label)) {
      frozen.add(model.label)
      // Only Ollama models are looked up in Ollama; the ONNX, mflux and local ones are pinned by revision.
      if (model.runtime === 'onnx') freezeOnnxModel(model.tag, model.revision!, model.dtype ?? 'fp32', model.capability)
      else if (model.runtime === 'local') freezeLocalModel(model.tag, model.revision!, model.capability ?? 'image-hash')
      else if (model.runtime === 'mflux') freezeMfluxModel(model.tag, model.revision!, model.dtype ?? '', model.base_model ?? '')
      else await freezeModel(model.tag, digest)
    }
    const waited = (await opts.before?.(e, index)) === true
    index++
    // Unload before every suite, not just every model: a model kept loaded
    // through the quality suites drifted (slower, larger) by the time perf
    // measured it (first run, 2026-10-31).
    await unloadAll()
    const finish = begin(e.model, e.suite, e.kind, conditions.length === 0 || waited)
    const out = join(outDir, e.suite, `${e.model.replace(/[:/]/g, '_')}${e.kind ? `.${e.kind}` : ''}.json`)
    mkdirSync(join(outDir, e.suite), { recursive: true })
    console.log(`\n=== ${e.model} · ${e.suite}${e.kind ? ` · ${e.kind}` : ''}`)
    const result = runner.run(
      [
        '-y', PROMPTFOO, 'eval',
        // npx runs from the package root, not `cwd`, so the path is absolute.
        '-c', join(SUITES_DIR, e.suite, 'promptfooconfig.yaml'),
        '--filter-providers', `^${escape(e.model)}$`,
        ...(e.kind ? ['--filter-metadata', `kind=${e.kind}`] : []),
        ...(opts.repeat && opts.repeat > 1 ? ['--repeat', String(opts.repeat)] : []),
        '--max-concurrency', '1',
        '--no-cache',
        '--no-progress-bar',
        '--no-table',
        '-o', out,
      ],
      {
        cwd: join(SUITES_DIR, e.suite),
        env: {
          ...process.env,
          PROMPTFOO_DISABLE_TELEMETRY: '1',
          PROMPTFOO_DISABLE_UPDATE: '1',
          // A case that runs longer fails as an error instead of stalling the
          // run: qwen3.5:4b on workout hung for two hours on 2026-11-01. Five
          // minutes unless the suite sets case_timeout_min (scripts/plan.ts).
          PROMPTFOO_EVAL_TIMEOUT_MS: String((metaOf(e.suite).case_timeout_min ?? 5) * 60_000),
        },
      },
    )
    const taken = finish()
    conditions.push(taken)
    writeConditions(join(RESULTS_DIR, 'conditions'), { run, evals: conditions })
    if (taken.flags.length > 0) console.log(`!! taken under load: ${taken.flags.join('; ')}`)
    // promptfoo exits 100 when a test fails, which is a result, not an error.
    if (result.exitCode !== 0 && result.exitCode !== 100) {
      failures.push(`${e.model} · ${e.suite}${e.kind ? ` · ${e.kind}` : ''}: exit ${result.exitCode}`)
      continue
    }
    append(
      recordsFromPromptfoo(out, {
        run,
        at: new Date().toISOString(),
        machine: host,
        ollama,
        promptfoo: PROMPTFOO_VERSION,
        model: { label: model.label, tag: model.tag, digest },
        suite: e.suite,
        suite_fp: fingerprints.get(e.suite)!,
        env,
      }),
    )
    done.push(e)
    await opts.after?.(e, run)
  }
  await unloadAll()
  return { run, done, failures, conditions }
}
