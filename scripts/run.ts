// Runs every suite against every model, one model at a time, and appends the
// scored cases to the ledger (scripts/ledger.ts).
//
// promptfoo orders work test by test, cycling through the providers inside
// each test, so a suite with six local models would swap models on every
// call: slow, and two can sit in memory at once. This runs one promptfoo
// eval per (model, suite) with --filter-providers, unloading before each,
// so exactly one model is loaded and the speed numbers are clean.
//
//   bun scripts/run.ts                       all models, all suites
//   bun scripts/run.ts --models qwen3:4b,granite4 --suites extract,classify
//   bun scripts/run.ts --suites search --kinds docs   only the cases of one kind (a provider's `config.kinds`)
//
// promptfoo's raw output lands in results/runs/<timestamp>/ (not committed);
// the records go to results/ledger/, and results/summary.md is rewritten.
import { existsSync, readdirSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { streamRunner } from '@osdlc/command-seam'
import { mfluxProblem, mfluxWeights } from './mflux.ts'
import { MODELS, skipReason } from './models.ts'
import {
  OLLAMA,
  PROMPTFOO_VERSION,
  RESULTS_DIR,
  SUITES_DIR,
  append,
  machine,
  modelDigests,
  ollamaVersion,
  freeze,
  recordsFromPromptfoo,
} from './ledger.ts'
import { captureEnvironment, freezeEnvironment, freezeLocalModel, freezeMfluxModel, freezeModel, freezeOnnxModel } from './env.ts'
import { summarize } from './summarize.ts'

const PROMPTFOO = `promptfoo@${PROMPTFOO_VERSION}`

const { values } = parseArgs({
  options: { models: { type: 'string' }, suites: { type: 'string' }, kinds: { type: 'string' } },
})
const pick = (list: string | undefined) => (list ? new Set(list.split(',')) : undefined)
const onlyModels = pick(values.models)
const onlySuites = pick(values.suites)
const onlyKinds = pick(values.kinds)

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The model labels each suite's config lists, with the case kinds a provider limits itself to
// (`config.kinds`, matched against each case's `metadata.kind`): a model that cannot take every
// kind of case in a suite runs only its own. No `kinds` means every case.
async function suiteLabels(suite: string): Promise<Map<string, string[] | null>> {
  const text = await Bun.file(join(SUITES_DIR, suite, 'promptfooconfig.yaml')).text()
  const config = Bun.YAML.parse(text) as { providers: { label: string; config?: { kinds?: string[] } }[] }
  return new Map(config.providers.map((p) => [p.label, p.config?.kinds ?? null] as const))
}

async function unloadAll(): Promise<void> {
  const { models } = (await (await fetch(`${OLLAMA}/api/ps`)).json()) as { models: { name: string }[] }
  for (const m of models) {
    // keep_alive 0 unloads; /api/generate works for chat and embedding models.
    await fetch(`${OLLAMA}/api/generate`, { method: 'POST', body: JSON.stringify({ model: m.name, keep_alive: 0 }) })
  }
}

const run = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const outDir = join(RESULTS_DIR, 'runs', run)
const suites = readdirSync(SUITES_DIR).filter((s) => !onlySuites || onlySuites.has(s))
const labels = new Map(await Promise.all(suites.map(async (s) => [s, await suiteLabels(s)] as const)))
// Freeze each suite before running it: the snapshot is what the records link to.
const fingerprints = new Map(suites.map((s) => [s, freeze(s)]))
const host = machine()
const ollama = await ollamaVersion()
const digests = await modelDigests()
const env = freezeEnvironment(await captureEnvironment())
const runner = streamRunner('npx')
const failures: string[] = []

for (const model of MODELS.filter((m) => !onlyModels || onlyModels.has(m.label))) {
  const skip = skipReason(model) ?? (model.runtime === 'mflux' ? mfluxProblem() ?? (existsSync(mfluxWeights(model)) ? null : 'weights missing: run `bun scripts/setup.ts`') : null)
  if (skip) {
    console.log(`\n--- skipping ${model.label}: ${skip}`)
    continue
  }
  const digest = model.runtime ? model.revision!.slice(0, 12) : digests.get(model.tag)
  if (!digest) {
    failures.push(`${model.label}: not installed (${model.tag})`)
    continue
  }
  // Only Ollama models are looked up in Ollama; the ONNX, mflux and local ones are pinned by revision.
  if (model.runtime === 'onnx') freezeOnnxModel(model.tag, model.revision!, model.dtype ?? 'fp32', model.capability)
  else if (model.runtime === 'local') freezeLocalModel(model.tag, model.revision!, model.capability ?? 'image-hash')
  else if (model.runtime === 'mflux') freezeMfluxModel(model.tag, model.revision!, model.dtype ?? '', model.base_model ?? '')
  else await freezeModel(model.tag, digest)
  for (const suite of suites.filter((s) => labels.get(s)!.has(model.label))) {
    // One promptfoo eval per kind of case the provider takes (one eval with every case when it lists none).
    for (const kind of (labels.get(suite)!.get(model.label) ?? [null]).filter((k) => !onlyKinds || (k !== null && onlyKinds.has(k)))) {
      // Unload before every suite, not just every model: a model kept loaded
      // through the quality suites drifted (slower, larger) by the time perf
      // measured it (first run, 2026-10-31).
      await unloadAll()
      const out = join(outDir, suite, `${model.label.replace(/[:/]/g, '_')}${kind ? `.${kind}` : ''}.json`)
      mkdirSync(join(outDir, suite), { recursive: true })
      console.log(`\n=== ${model.label} · ${suite}${kind ? ` · ${kind}` : ''}`)
      const result = runner.run(
        [
          '-y', PROMPTFOO, 'eval',
          // npx runs from the package root, not `cwd`, so the path is absolute.
          '-c', join(SUITES_DIR, suite, 'promptfooconfig.yaml'),
          '--filter-providers', `^${escape(model.label)}$`,
          ...(kind ? ['--filter-metadata', `kind=${kind}`] : []),
          '--max-concurrency', '1',
          '--no-cache',
          '--no-progress-bar',
          '--no-table',
          '-o', out,
        ],
        {
          cwd: join(SUITES_DIR, suite),
          env: {
            ...process.env,
            PROMPTFOO_DISABLE_TELEMETRY: '1',
            PROMPTFOO_DISABLE_UPDATE: '1',
            // A case that runs longer fails as an error instead of stalling the
            // run: qwen3.5:4b on workout hung for two hours on 2026-11-01.
            PROMPTFOO_EVAL_TIMEOUT_MS: String(5 * 60_000),
          },
        },
      )
      // promptfoo exits 100 when a test fails, which is a result, not an error.
      if (result.exitCode !== 0 && result.exitCode !== 100) {
        failures.push(`${model.label} · ${suite}${kind ? ` · ${kind}` : ''}: exit ${result.exitCode}`)
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
          suite,
          suite_fp: fingerprints.get(suite)!,
          env,
        }),
      )
    }
  }
}
await unloadAll()

console.log(`\nSummary: ${summarize()}`)
if (failures.length > 0) {
  console.error(`Runs that errored:\n${failures.join('\n')}`)
  process.exit(1)
}
