// Sets up a suite in a private collection: cases and images that can't be
// published (personal photos, screenshots of unreleased software, internal
// documents). private/ is gitignored. Run the private suites with
// EVALS_SCOPE=private; their snapshots, ledger and raw output go to
// private/results/, and the site export refuses them.
//
//   bun scripts/init-private.ts nudity-flag                  a private copy of a public suite
//   bun scripts/init-private.ts screens --from tag-image     a private-only suite, starting from a public one's config
//   EVALS_SCOPE=private bun run eval --suites nudity-flag
//
// Either way the suite gets the public config (file paths adjusted to the
// deeper folder), an empty cases/, a template case and a suite.yaml with the
// public suite's categories and cost (scripts/plan.ts).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './ledger.ts'
import { SUITE_META } from './plan.ts'

const [suite, flag, base = suite] = process.argv.slice(2)
if (!suite || (flag !== undefined && flag !== '--from')) throw new Error('usage: bun scripts/init-private.ts <suite> [--from <public suite>]')
const from = join(ROOT, 'suites', base!, 'promptfooconfig.yaml')
if (!existsSync(from)) throw new Error(`no public suite ${base}${flag ? '' : '; for a private-only suite, pass --from <public suite> to start from its config'}`)
const dir = join(ROOT, 'private', 'suites', suite)
if (existsSync(dir)) throw new Error(`${dir} already exists`)
mkdirSync(join(dir, 'cases'), { recursive: true })
mkdirSync(join(ROOT, 'private', 'images'), { recursive: true })

// One folder deeper, so every relative file:// path climbs one more level.
const config = readFileSync(from, 'utf8').replaceAll('file://../../', 'file://../../../')
writeFileSync(join(dir, 'promptfooconfig.yaml'), `# Private suite, from suites/${base}; edit freely, it is not committed.\n${config}`)
const meta = SUITE_META[base!]
if (meta) {
  writeFileSync(
    join(dir, 'suite.yaml'),
    `# Categories and cost for run selection (scripts/plan.ts), from suites/${base}.\ncategories: [${meta.categories.join(', ')}]\ncost: ${meta.cost}\n${meta.case_timeout_min ? `case_timeout_min: ${meta.case_timeout_min}\n` : ''}`,
  )
}
writeFileSync(
  join(dir, 'cases', 'example.yaml.template'),
  `# Copy to <id>.yaml (the file name is the id). Images go in private/images/.
# Once a run uses a case it never changes, as in the public suites.
# Copy vars and expected from a case in suites/${base}/cases/.
description: what this case checks
metadata: { id: example }
vars:
  image: file://../../../images/example.jpg
`,
)
console.log(`${dir}: config copied; add cases in cases/ and images in private/images/`)
