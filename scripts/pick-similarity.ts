// Builds the similarity suite's inputs: the query list, the candidate pool and
// one case per query. The choices are written down here so a later person can
// see why an image counts as "the same scene" or "the same kind of thing".
//
//   bun scripts/pick-similarity.ts sources   add the scene photos and the derived copies to corpus/sources.yaml
//   bun scripts/fetch-corpus.ts              download the scene photos, make the copies
//   bun scripts/pick-similarity.ts write     write suites/similarity/pool.yaml and cases/sim-<query>.yaml
//
// `write` never overwrites a case (cases are immutable); it rewrites pool.yaml,
// which belongs to the suite's setup, so a changed pool is a new suite version.
//
// Levels (docs/plans/similarity.md). A candidate is labelled by its ORIGINAL,
// the photo it came from, so a resized copy of another dog photo is a `class`
// match for a dog query just as that photo is:
// - copy:  the query itself, resized / recompressed / cropped / flipped /
//          brightened (RECIPES in scripts/fetch-corpus.ts, committed as
//          corpus images so their bytes never move; two per query);
// - edit:  the query's own edit-suite output (results/edits/edit/<model>/);
// - scene: another photo of the same place or object (SCENES);
// - class: a different photo of the same kind of thing (GROUPS);
// - other: everything else in the pool.
// The pool is every non-sensitive corpus photo (no nudity-related, swimwear or
// face images), the copies and the edits.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { CorpusImage } from './fetch-corpus.ts'
import { RECIPES, type Recipe } from './recipes.ts'
import { ROOT, SUITES_DIR } from './ledger.ts'

const EDIT_MODEL = 'flux2-klein-4b-q4'
const SUITE = join(SUITES_DIR, 'similarity')
const oi = (id: string) => `oi-objects-${id}`

/**
 * Open Images photos added for the scene level: two photos each of one car and
 * one race, by the same photographer (CC BY 2.0). Found by pairing a
 * photographer's images whose Flickr ids are close in the Open Images index,
 * then checked by eye.
 */
const SCENE_PHOTOS: { id: string; openimages: string }[] = [
  { id: 'oi-scene-spitfire-a', openimages: 'd28d71c2690c16ed' },
  { id: 'oi-scene-spitfire-b', openimages: 'c39336fda04d5dfe' },
  { id: 'oi-scene-monaco-a', openimages: '438f461a5f6d8e7e' },
  { id: 'oi-scene-monaco-b', openimages: 'a582197dff522ef5' },
]

/** Photos of one place or one object, taken together. Each member is a query and the others are its scene matches. */
const SCENES: Record<string, string[]> = {
  'black-forest-trail': ['millipede-moss', 'forest-trail', 'tree-bracket-fungus'],
  'triumph-spitfire': ['oi-scene-spitfire-a', 'oi-scene-spitfire-b'],
  'monaco-grand-prix': ['oi-scene-monaco-a', 'oi-scene-monaco-b'],
}

/** The same kind of thing, different photos. Membership is judged from the contact sheet, not from file names. */
const GROUPS: Record<string, string[]> = {
  dog: ['dog-border-terrier', 'dog-in-dog-bed', 'dog-autumn-sun', 'dog-sleeping-painting', oi('948794bfee784412'), oi('0fd512f1bffb8cf3'), oi('d8cac8b54e9fa89c'), oi('5b7ab3baf4c0492f'), 'oi-find-030c5a10124e6252'],
  horse: ['horses-flooded-pasture', 'horses-pasture-house'],
  salad: ['salad-ham', 'salad-party-dish', 'salad-rucola-plate'],
  pancakes: ['pancakes-breakfast-table', 'pancakes-stack'],
  'bike-parking': ['bike-parking-oakland', 'bike-parking-three-styles'],
  cyclist: ['oi-find-6022a450df278025', 'oi-find-8f08cb18c27fbaa7'],
  'laptop-desk': ['laptop-notepad', 'desk-coffee-laptop-notebook', 'desk-laptop-notebook-pen', 'desk-laptop-top-down', oi('7408fef212a5d3bc'), oi('a7e5d2727af4299d')],
  coffee: ['coffee-montreal', 'coffee-snacks-table', 'coffee-shop-counter', oi('25d107f1590c1772')],
  'lake-mountain': ['lake-salagou', 'lake-sherburne', 'mountain-lake-dam'],
  sunset: ['sunset-boats', 'sunset-beach-colonia'],
  forest: ['forest-trail', 'tree-bracket-fungus', 'snow-forest-trail', 'millipede-moss'],
  library: ['library-stacks-vasconcelos', 'library-laukaa'],
  'night-street': ['street-night-rostov', 'diner-snow-night', 'railway-station-dark'],
  armchair: [oi('ee47ccab89a75d0d'), oi('5ea13fbbd1a1474f'), oi('2b2c4fe6d63a13e4')],
  watch: ['oi-find-149a74e86e8161a5', 'oi-find-66a342dcdafc7607'],
  lamp: ['oi-find-e916dd0b766b2f40', 'oi-find-743dbcab02a9971e', 'oi-find-a90c22661fe961ff'],
  guitar: ['oi-find-29de4e35add89b69', 'oi-find-c4d62e55691ed1e4'],
  pen: ['oi-find-2dcab96f79ef52c4', 'oi-find-07caab7b663b7e86'],
  handwriting: ['letter-handwritten-short', 'recipe-daffys-elixir', 'recipe-rheumatism'],
  'train-ticket': ['train-ticket-french', 'train-ticket-chinese'],
  car: [oi('28bd6c6b1050e055'), 'oi-scene-spitfire-a', 'oi-scene-spitfire-b'],
  document: ['receipt-grocery', 'invoice-simple', 'shipping-label', 'recipe-card', 'event-flyer'],
  'ui-screen': ['settings-panel', 'jobs-table', 'error-dialog'],
}

/** Queries that are not an edit original or a scene member: one per group of the kinds above, by hand. */
const CLASS_QUERIES = [
  'dog-border-terrier', 'horses-flooded-pasture', 'salad-rucola-plate', 'bike-parking-oakland', 'desk-laptop-top-down', 'lake-sherburne',
  'library-laukaa', 'oi-find-149a74e86e8161a5', 'oi-find-c4d62e55691ed1e4', 'train-ticket-french', 'recipe-daffys-elixir', 'street-night-rostov',
]

const RECIPE_ORDER = Object.keys(RECIPES) as Recipe[]

type Kind = 'original' | 'copy' | 'edit'
interface PoolItem { id: string; file: string; kind: Kind; of?: string }

/** The edit suite's cases: case id to the corpus image it edits. */
function editOriginals(): Map<string, string> {
  const dir = join(SUITES_DIR, 'edit', 'cases')
  return new Map(
    readdirSync(dir)
      .filter((f) => f.endsWith('.yaml'))
      .map((f) => {
        const def = Bun.YAML.parse(readFileSync(join(dir, f), 'utf8')) as { vars: { image: string } }
        return [basename(f, '.yaml'), basename(def.vars.image).replace(/\.(jpg|png)$/, '')] as const
      }),
  )
}

/** The queries, in a fixed order: edit originals, scene members, then the class-only ones. */
function queries(edits: Map<string, string>): string[] {
  return [...new Set([...edits.values(), ...Object.values(SCENES).flat(), ...CLASS_QUERIES])]
}

const copiesOf = (queryList: string[]) =>
  queryList.flatMap((q, i) => [RECIPE_ORDER[i % RECIPE_ORDER.length]!, RECIPE_ORDER[(i + 2) % RECIPE_ORDER.length]!].map((recipe) => ({ id: `copy-${recipe}-${q}`, derived: q, recipe })))

const command = process.argv[2]
const edits = editOriginals()
const queryList = queries(edits)

if (command === 'sources') {
  const path = join(ROOT, 'corpus', 'sources.yaml')
  const text = readFileSync(path, 'utf8')
  const lines = [
    '',
    '# Similarity suite (scripts/pick-similarity.ts). Scene photos: Open Images, two of one car and',
    '# two of one race, by the same photographer. Copies: each query resized, recompressed, cropped,',
    '# flipped or brightened (RECIPES in scripts/fetch-corpus.ts); they keep their parent\'s credit.',
    ...SCENE_PHOTOS.filter((s) => !text.includes(`id: ${s.id},`)).map((s) => `- { id: ${s.id}, category: similarity-scene, openimages: '${s.openimages}' }`),
    ...copiesOf(queryList).filter((c) => !text.includes(`id: ${c.id},`)).map((c) => `- { id: ${c.id}, category: similarity-copy, derived: ${c.derived}, recipe: ${c.recipe} }`),
  ]
  if (lines.length > 4) appendFileSync(path, `${lines.join('\n')}\n`)
  console.log(`${lines.length - 4} entries appended; run scripts/fetch-corpus.ts`)
} else if (command === 'write') {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'corpus', 'manifest.json'), 'utf8')) as CorpusImage[]
  const SKIP_CATEGORIES = new Set(['nude', 'art', 'swimwear', 'regions-faces'])
  const pool: PoolItem[] = []
  for (const m of manifest) {
    if (m.sensitive || SKIP_CATEGORIES.has(m.category)) continue
    pool.push({ id: m.id, file: `corpus/${m.file}`, kind: m.derived_from ? 'copy' : 'original', ...(m.derived_from ? { of: m.derived_from } : {}) })
  }
  const editDir = join('results', 'edits', 'edit', EDIT_MODEL)
  for (const [caseId, original] of edits) {
    const files = readdirSync(join(ROOT, editDir)).filter((f) => f.startsWith(`${caseId}-`))
    if (files.length !== 1) throw new Error(`${caseId}: expected one edit output in ${editDir}, found ${files.length}`)
    pool.push({ id: caseId, file: join(editDir, files[0]!), kind: 'edit', of: original })
  }
  const ids = new Set(pool.map((p) => p.id))
  for (const q of queryList) if (!ids.has(q)) throw new Error(`query ${q} is not in the pool (run fetch-corpus.ts?)`)
  for (const g of Object.values(GROUPS).flat()) if (!ids.has(g)) throw new Error(`group member ${g} is not in the pool`)

  const sceneOf = (q: string) => Object.values(SCENES).find((s) => s.includes(q)) ?? []
  const classOf = (q: string) => Object.values(GROUPS).filter((g) => g.includes(q)).flat()
  const sourceOf = (p: PoolItem) => p.of ?? p.id
  const levelOf = (q: string, p: PoolItem): 'copy' | 'edit' | 'scene' | 'class' | 'other' | null => {
    const s = sourceOf(p)
    if (p.id === q) return null
    if (s === q) return p.kind === 'copy' ? 'copy' : 'edit'
    if (sceneOf(q).includes(s)) return 'scene'
    if (classOf(q).includes(s)) return 'class'
    return 'other'
  }

  mkdirSync(join(SUITE, 'cases'), { recursive: true })
  const poolText = [
    '# The candidates every similarity case is ranked against: each non-sensitive corpus photo, the',
    '# copies made of the queries (kind: copy) and the edit suite\'s outputs (kind: edit). `of` names the',
    '# photo a copy or edit came from. Written by scripts/pick-similarity.ts.',
    ...pool.map((p) => `- { id: ${p.id}, file: ${p.file}, kind: ${p.kind}${p.of ? `, of: ${p.of}` : ''} }`),
    '',
  ].join('\n')
  writeFileSync(join(SUITE, 'pool.yaml'), poolText)

  let written = 0
  for (const q of queryList) {
    const levels: Record<string, string[]> = { copy: [], edit: [], scene: [], class: [] }
    for (const p of pool) {
      const level = levelOf(q, p)
      if (level && level !== 'other') levels[level]!.push(p.id)
    }
    const id = `sim-${q}`
    const file = join(SUITE, 'cases', `${id}.yaml`)
    if (existsSync(file)) continue
    const parts = Object.entries(levels).filter(([, v]) => v.length > 0)
    const lines = [
      `description: "similarity: ${q} (${parts.map(([k, v]) => `${v.length} ${k}`).join(', ')} of ${pool.length - 1})"`,
      `metadata: { id: ${id} }`,
      'vars:',
      `  query: ${q}`,
      '  expected:',
      ...parts.map(([k, v]) => `    ${k}: [${v.join(', ')}]`),
      '',
    ]
    writeFileSync(file, lines.join('\n'))
    written++
  }
  console.log(`${queryList.length} queries, ${pool.length} candidates; ${written} new case files`)
} else {
  console.error('usage: bun scripts/pick-similarity.ts sources | write')
  process.exit(2)
}
