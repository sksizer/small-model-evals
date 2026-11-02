// Prepares a machine to run the suites: pulls the Ollama models the runner
// would run, downloads the pinned weights of the mflux image editors, and
// says what is missing. Safe to re-run: it skips what is already there.
//
//   bun scripts/setup.ts                         every model the runner would run
//   bun scripts/setup.ts --models qwen3.5:4b     a subset
//   bun scripts/setup.ts --dry-run               report only, change nothing
//
// Models older than the age limit (scripts/models.ts) are skipped, as the
// runner skips them. ONNX models need no setup: transformers.js and
// providers/onnx-detector.ts download their pinned weights on first use, into
// the Hugging Face cache and .cache/models/.
//
// mflux editors run only on Apple silicon. Elsewhere they are reported and
// skipped, and the runner skips them too. mflux itself is installed by hand
// (`uv tool install mflux==0.24.0`), since it is a Python tool outside this
// package.
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { streamRunner } from '@osdlc/command-seam'
import { MODELS, skipReason, type ModelEntry } from './models.ts'
import { ROOT } from './ledger.ts'
import { mfluxProblem, mfluxWeights, MFLUX_VERSION } from './mflux.ts'

const OLLAMA = process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434'

const { values } = parseArgs({ options: { models: { type: 'string' }, 'dry-run': { type: 'boolean' } } })
const only = values.models ? new Set(values.models.split(',')) : null
const dry = values['dry-run'] ?? false
const todo: string[] = []

const installed = async (): Promise<Set<string> | null> => {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`)
    const body = (await res.json()) as { models: { name: string }[] }
    return new Set(body.models.map((m) => m.name))
  } catch {
    return null
  }
}

/** Every file of a Hugging Face repo at one commit, into `dir`. */
async function download(repo: string, revision: string, dir: string): Promise<void> {
  const res = await fetch(`https://huggingface.co/api/models/${repo}/tree/${revision}?recursive=1`)
  if (!res.ok) throw new Error(`${repo}@${revision}: HTTP ${res.status}`)
  const files = ((await res.json()) as { type: string; path: string; size: number }[]).filter((f) => f.type === 'file')
  for (const f of files) {
    const to = join(dir, f.path)
    if (existsSync(to) && Bun.file(to).size === f.size) continue
    console.log(`  ${f.path} (${(f.size / 2 ** 20).toFixed(0)} MB)`)
    const got = await fetch(`https://huggingface.co/${repo}/resolve/${revision}/${f.path}`)
    if (!got.ok) throw new Error(`${repo}/${f.path}: HTTP ${got.status}`)
    mkdirSync(dirname(to), { recursive: true })
    // Written to a temporary name first, so an interrupted download is retried.
    await Bun.write(`${to}.part`, got)
    renameSync(`${to}.part`, to)
  }
}

const models: ModelEntry[] = MODELS.filter((m) => !only || only.has(m.label))
const have = await installed()
if (!have) todo.push(`Ollama is not running at ${OLLAMA}: install it from https://ollama.com and start it`)
const pull = streamRunner('ollama')

for (const m of models) {
  const skip = skipReason(m)
  if (skip) {
    console.log(`skip ${m.label}: ${skip}`)
    continue
  }
  if (m.runtime === 'onnx') continue
  if (m.runtime === 'mflux') {
    const problem = mfluxProblem()
    if (problem) {
      todo.push(`${m.label}: ${problem}`)
      if (problem.includes('Apple silicon')) continue
    }
    const dir = mfluxWeights(m)
    console.log(`${m.label}: weights ${existsSync(dir) ? 'present, checking' : 'downloading'} (${m.tag}@${m.revision!.slice(0, 7)})`)
    if (!dry) await download(m.tag, m.revision!, dir)
    continue
  }
  if (!have) continue
  if (have.has(m.tag) || have.has(`${m.tag}:latest`)) {
    console.log(`${m.label}: present`)
    continue
  }
  console.log(`${m.label}: pulling ${m.tag}`)
  if (!dry && pull.run(['pull', m.tag], { cwd: ROOT }).exitCode !== 0) todo.push(`${m.label}: \`ollama pull ${m.tag}\` failed`)
}

if (todo.length > 0) {
  console.log('\nStill to do:')
  for (const t of todo) console.log(`- ${t}`)
  process.exitCode = 1
} else console.log(`\nReady${dry ? ' (dry run)' : ''}. mflux ${MFLUX_VERSION} is the version the edit suite was run with.`)
