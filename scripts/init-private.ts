// Sets up a private copy of a suite for cases built from your own notes or
// photos: private/suites/<suite>/ with the public config (file paths adjusted
// to the deeper folder), an empty cases/ and a template case. private/ is
// gitignored. Run the private suites with EVALS_SCOPE=private; their
// snapshots, ledger and raw output go to private/results/, and the site
// export refuses them.
//
//   bun scripts/init-private.ts nudity-flag
//   EVALS_SCOPE=private bun run eval --suites nudity-flag
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './ledger.ts'

const suite = process.argv[2]
if (!suite) throw new Error('usage: bun scripts/init-private.ts <suite>')
const from = join(ROOT, 'suites', suite, 'promptfooconfig.yaml')
if (!existsSync(from)) throw new Error(`no public suite ${suite}`)
const dir = join(ROOT, 'private', 'suites', suite)
if (existsSync(dir)) throw new Error(`${dir} already exists`)
mkdirSync(join(dir, 'cases'), { recursive: true })
mkdirSync(join(ROOT, 'private', 'images'), { recursive: true })

// One folder deeper, so every relative file:// path climbs one more level.
const config = readFileSync(from, 'utf8').replaceAll('file://../../', 'file://../../../')
writeFileSync(join(dir, 'promptfooconfig.yaml'), `# Private copy of suites/${suite}; edit freely, it is not committed.\n${config}`)
writeFileSync(
  join(dir, 'cases', 'example.yaml.template'),
  `# Copy to <id>.yaml (the file name is the id). Images go in private/images/.
# Once a run uses a case it never changes, as in the public suites.
description: what this photo is
metadata: { id: example }
vars:
  image: file://../../../images/example.jpg
  expected: { nudity: 'yes' }
`,
)
console.log(`${dir}: config copied; add cases in cases/ and images in private/images/`)
