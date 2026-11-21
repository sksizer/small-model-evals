// Adds a run's raw promptfoo output to the ledger. scripts/run.ts does this
// itself after every eval; this is for output made before the ledger existed,
// or a run whose append failed.
//
//   bun scripts/import.ts results/runs/<timestamp>
//
// The machine, Ollama version and model digests are read now, not at run
// time, and each suite is frozen as it stands now, so import only a run made
// on this machine with these models and unchanged suites. Every case must
// carry its metadata.id.
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { machine } from './machine.ts'
import { MODELS } from './models.ts'
import {
  PROMPTFOO_VERSION,
  append,
  modelDigests,
  ollamaVersion,
  freeze,
  recordsFromPromptfoo,
} from './ledger.ts'

const dir = process.argv[2]
if (!dir) throw new Error('usage: bun scripts/import.ts results/runs/<timestamp>')

const run = basename(dir)
const host = machine()
const ollama = await ollamaVersion()
const digests = await modelDigests()
let count = 0

for (const suite of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
  const fp = freeze(suite)
  for (const file of readdirSync(join(dir, suite)).filter((f) => f.endsWith('.json'))) {
    const path = join(dir, suite, file)
    const label = MODELS.find((m) => m.label.replace(/[:/]/g, '_') === basename(file, '.json'))?.label
    const model = MODELS.find((m) => m.label === label)
    if (!model) throw new Error(`${path}: no model in scripts/models.ts matches ${file}`)
    const at = (JSON.parse(readFileSync(path, 'utf8')) as { results: { timestamp: string } }).results.timestamp
    const records = recordsFromPromptfoo(
      path,
      {
        run,
        at,
        machine: host,
        ollama,
        promptfoo: PROMPTFOO_VERSION,
        model: { label: model.label, tag: model.tag, digest: digests.get(model.tag) ?? 'unknown' },
        suite,
        suite_fp: fp,
      },
    )
    append(records)
    count += records.length
  }
}
console.log(`${count} records from ${run}`)
