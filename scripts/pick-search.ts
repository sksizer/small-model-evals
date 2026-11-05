// Builds the search suite's inputs: the four corpora (suites/search/corpora.yaml) and one
// case per query (suites/search/cases/*.yaml). The choices are written down here so a later
// person can see why a candidate counts as relevant (docs/plans/search.md).
//
//   bun scripts/pick-search.ts
//
// Never overwrites a case (cases are immutable, README: Cases); rewrites corpora.yaml, which
// belongs to the suite's setup, so a changed corpus is a new suite version.
//
// Corpora:
// - photos: every non-sensitive corpus photo (no nudity, swimwear, faces, sensitive-* images,
//   derived copies, nor the synthetic pages): 78 images.
// - docs: the 44 synthetic pages (corpus/images/*.png: cards, statements, letters,
//   screenshots), searched as images.
// - foods: 1500 of the 7793 USDA SR Legacy foods (public domain): every food a query's rule
//   calls relevant, plus a seeded-hash fill, so the rest is a fair crowd of distractors.
// - notes: 60 invented notes (suites/search/notes.yaml, CC0).
//
// Relevance:
// - photos, `auto` queries: the classes of Open Images V7 annotations (image-level human
//   labels at confidence 1, and boxes) on the oi-* photos, plus, for the photos Open Images
//   does not cover (Commons photos), the ones judged by eye (`byEye`). Open Images labels
//   are sparse (a class not annotated is not "absent"), so an auto query is only as complete
//   as the annotation; the few queries where the annotation misses a clear case were
//   extended by eye and say so.
// - photos, hand-written queries and docs: judged by eye from the images.
// - foods: a regular expression on the food's name (below), applied to the whole database;
//   the case lists the ids in the subset that match.
// - notes: judged by reading; a query lists the one or two notes that answer it.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { csvLine, OI_CACHE } from './openimages.ts'
import { ROOT, SUITES_DIR } from './ledger.ts'

const SUITE = join(SUITES_DIR, 'search')
const yaml = (v: unknown) => JSON.stringify(v) // JSON is YAML

interface Manifest {
  id: string
  category: string
  file: string
  title: string
  sensitive?: boolean
}
const manifest = JSON.parse(readFileSync(join(ROOT, 'corpus', 'manifest.json'), 'utf8')) as Manifest[]

// ---- photos and docs -------------------------------------------------------------------------
const SKIP = new Set(['nude', 'swimwear', 'regions-faces', 'similarity-copy'])
const photos = manifest.filter((m) => !m.sensitive && !SKIP.has(m.category) && !m.file.endsWith('.png') && !m.category.startsWith('sensitive'))
const docs = manifest.filter((m) => m.file.endsWith('.png'))
const photoIds = new Set(photos.map((p) => p.id))
const docIds = new Set(docs.map((d) => d.id))

/** Open Images id → corpus id, for the photos that came from Open Images. */
const oiHex = new Map(photos.flatMap((p) => { const m = /^Open Images (\w+):/.exec(p.title); return m ? [[m[1]!, p.id] as const] : [] }))
const classNames = new Map<string, string>()
for (const l of readFileSync(join(OI_CACHE, 'oidv7-class-descriptions.csv'), 'utf8').split(/\r?\n/).filter(Boolean)) { const c = csvLine(l); classNames.set(c[0]!, c[1]!) }
const annotated = new Map<string, Set<string>>() // class → corpus ids
const note = (cls: string, hex: string) => { const id = oiHex.get(hex); if (id) annotated.set(cls, (annotated.get(cls) ?? new Set()).add(id)) }
for (const l of readFileSync(join(OI_CACHE, 'validation-annotations-human-imagelabels.csv'), 'utf8').split(/\r?\n/).slice(1)) {
  const c = csvLine(l)
  if (c[3] === '1' && c[0]) note(classNames.get(c[2]!) ?? '', c[0])
}
for (const l of readFileSync(join(OI_CACHE, 'validation-annotations-bbox.csv'), 'utf8').split(/\r?\n/).slice(1)) {
  const c = csvLine(l)
  if (c[0]) note(classNames.get(c[2]!) ?? '', c[0])
}

interface Query { slug: string; query: string; relevant: string[]; how?: string }
const oi = (classes: string[], byEye: string[] = []): { relevant: string[]; how?: string } => {
  const set = new Set([...classes.flatMap((c) => [...(annotated.get(c) ?? [])]), ...byEye.map((s) => (photoIds.has(s) ? s : `oi-${s}`))])
  return { relevant: [...set].sort(), how: `Open Images: ${classes.join(' + ')}${byEye.length ? `; by eye: ${byEye.length} Commons or unannotated photo${byEye.length === 1 ? '' : 's'}` : ''}` }
}
const eye = (ids: string[]) => ({ relevant: ids.map((s) => (photoIds.has(s) ? s : `oi-${s}`)).sort(), how: 'judged by eye' })

const PHOTO_QUERIES: Query[] = [
  { slug: 'dog', query: 'a dog', ...oi(['Dog'], ['dog-sleeping-painting', 'dog-border-terrier', 'dog-in-dog-bed', 'dog-autumn-sun']) },
  { slug: 'bicycle', query: 'a bicycle', ...oi(['Bicycle'], ['bike-parking-oakland']) },
  { slug: 'car', query: 'a car', ...oi(['Car'], ['sidewalk-cafe']) },
  { slug: 'couch', query: 'a couch', ...oi(['Couch']) },
  { slug: 'chair', query: 'a chair', ...oi(['Chair']) },
  { slug: 'houseplant', query: 'a houseplant', ...oi(['Houseplant']) },
  { slug: 'lamp', query: 'a lamp', ...oi(['Lamp']) },
  { slug: 'laptop', query: 'a laptop', ...oi(['Laptop'], ['laptop-notepad', 'desk-coffee-laptop-notebook', 'desk-laptop-notebook-pen', 'desk-laptop-top-down']) },
  { slug: 'guitar', query: 'a guitar', ...oi(['Guitar']) },
  { slug: 'watch', query: 'a wrist watch', ...oi(['Watch']) },
  { slug: 'person', query: 'a person', ...oi(['Person', 'Man']) },
  { slug: 'helmet', query: 'a bicycle helmet', ...oi(['Bicycle helmet']) },
  { slug: 'wine-glass', query: 'a wine glass', ...oi(['Wine glass']) },
  { slug: 'dachshunds-car-window', query: 'two dogs looking out of a car window', ...eye(['objects-0fd512f1bffb8cf3']) },
  { slug: 'sleeping-dog', query: 'a sleeping dog', ...eye(['dog-autumn-sun', 'dog-border-terrier', 'dog-in-dog-bed', 'dog-sleeping-painting']) },
  { slug: 'horses-flood', query: 'two horses grazing in a flooded field', ...eye(['horses-flooded-pasture']) },
  { slug: 'sunset-boats', query: 'a sunset over the sea with boats', ...eye(['sunset-boats']) },
  { slug: 'snow-trail', query: 'a snowy forest trail', ...eye(['snow-forest-trail']) },
  { slug: 'parrot', query: 'a green parrot on a branch', ...eye(['parrot-illustration']) },
  { slug: 'salad-tomatoes', query: 'a plate of salad with tomatoes', ...eye(['salad-party-dish', 'salad-rucola-plate']) },
  { slug: 'pancakes', query: 'pancakes for breakfast', ...eye(['pancakes-stack', 'pancakes-breakfast-table']) },
  { slug: 'race-car', query: 'a red racing car on a track', ...eye(['scene-monaco-a', 'scene-monaco-b']) },
  { slug: 'snow-lake', query: 'a mountain lake with snow-capped peaks', ...eye(['lake-sherburne', 'mountain-lake-dam']) },
  { slug: 'library', query: 'a library with shelves of books', ...eye(['library-stacks-vasconcelos', 'library-laukaa']) },
  { slug: 'old-recipe', query: 'an old handwritten recipe manuscript', ...eye(['recipe-daffys-elixir', 'recipe-rheumatism']) },
]

const DOC_QUERIES: Query[] = ([
  { slug: 'passport', query: 'my passport', relevant: ['passport-data-page'] },
  { slug: 'prescription', query: 'the prescription label from the pharmacy', relevant: ['prescription-label'] },
  { slug: 'wifi', query: 'the wifi password', relevant: ['wifi-password-card'] },
  { slug: 'bank-statement', query: 'bank statement for October', relevant: ['bank-statement'] },
  { slug: 'recipe', query: 'a recipe card for a loaf cake', relevant: ['recipe-card'] },
  { slug: 'receipt', query: 'receipt from the grocery store', relevant: ['receipt-grocery'] },
  { slug: 'boarding-pass', query: 'boarding pass for the flight to New York', relevant: ['boarding-pass'] },
  { slug: 'driving-licence', query: 'driving licence', relevant: ['driving-licence'] },
  { slug: 'bank-card', query: 'a bank card', relevant: ['bank-card-credit', 'bank-card-debit'] },
  { slug: 'photo-id', query: 'a photo identity card', relevant: ['id-national-card', 'student-id-card', 'residence-permit-card', 'driving-licence'] },
  { slug: 'electricity-bill', query: 'the electricity bill', relevant: ['utility-bill'] },
  { slug: 'payslip', query: 'my monthly payslip', relevant: ['pay-slip'] },
  { slug: 'invoice', query: 'invoice for pottery', relevant: ['invoice-simple'] },
  { slug: 'blood-test', query: 'blood test results', relevant: ['lab-result'] },
  { slug: 'vaccination', query: 'vaccination record', relevant: ['vaccination-card'] },
  { slug: 'bus-timetable', query: 'bus timetable', relevant: ['bus-timetable'] },
  { slug: 'menu', query: 'a restaurant menu', relevant: ['restaurant-menu'] },
  { slug: 'recovery-codes', query: 'two-factor backup codes', relevant: ['recovery-codes'] },
  { slug: 'shipping-label', query: 'shipping label on a parcel', relevant: ['shipping-label'] },
  { slug: 'sms-code', query: 'a text message with a security code', relevant: ['sms-code'] },
  { slug: 'flyer', query: 'poster for a seed swap event', relevant: ['event-flyer'] },
  { slug: 'disk-full', query: 'error message about a full disk', relevant: ['error-dialog'] },
  { slug: 'tax-notice', query: 'tax assessment notice', relevant: ['tax-notice'] },
  { slug: 'insurance-card', query: 'health insurance card', relevant: ['health-insurance-card'] },
] as Query[]).map((q) => ({ ...q, how: 'judged by eye' }))

// ---- foods -----------------------------------------------------------------------------------
interface Food { id: number; name: string; category: string }
const foods = readFileSync(join(SUITES_DIR, 'food-lookup', 'foods.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Food)
/** Each query's rule on the food's name, applied to the whole database. */
const FOOD_QUERIES: { slug: string; query: string; rule: RegExp; rule_text: string }[] = [
  { slug: 'raw-spinach', query: 'raw spinach', rule: /^spinach, raw\b/i, rule_text: 'name starts "Spinach, raw"' },
  { slug: 'greek-yogurt', query: 'low-fat greek yogurt', rule: /^yogurt, greek.*(lowfat|nonfat)/i, rule_text: 'Yogurt, Greek, lowfat or nonfat' },
  { slug: 'chicken-thigh', query: 'boneless chicken thigh, roasted', rule: /^chicken\b.*thigh, meat (only|and skin).*roasted/i, rule_text: 'chicken, thigh, meat only or meat and skin (no bone), roasted' },
  { slug: 'hard-boiled-egg', query: 'hard-boiled egg', rule: /^egg\b.*hard-boiled/i, rule_text: 'egg, hard-boiled' },
  { slug: 'brown-rice', query: 'cooked brown rice', rule: /^rice, brown,.*\bcooked\b/i, rule_text: 'Rice, brown, ... cooked' },
  { slug: 'skim-milk', query: 'skim milk', rule: /^milk, nonfat, fluid/i, rule_text: 'Milk, nonfat, fluid (fat free or skim)' },
  { slug: 'lean-beef', query: 'extra lean ground beef, 95%', rule: /^beef, ground, 95%/i, rule_text: 'Beef, ground, 95% lean' },
  { slug: 'wholewheat-bread', query: 'whole wheat bread', rule: /^bread, whole-wheat/i, rule_text: 'Bread, whole-wheat' },
  { slug: 'baked-potato', query: 'baked potato', rule: /^potatoes, baked/i, rule_text: 'Potatoes, baked' },
  { slug: 'firm-tofu', query: 'firm tofu', rule: /^tofu, (raw, )?firm/i, rule_text: 'Tofu, firm' },
  { slug: 'cooked-lentils', query: 'boiled lentils', rule: /^lentils\b.*cooked, boiled/i, rule_text: 'Lentils, ... cooked, boiled' },
  { slug: 'avocado', query: 'avocado', rule: /^avocados, raw/i, rule_text: 'Avocados, raw' },
  { slug: 'canned-tuna', query: 'canned tuna in water', rule: /^fish, tuna.*canned in water/i, rule_text: 'Fish, tuna, canned in water' },
  { slug: 'cheddar', query: 'cheddar cheese', rule: /^cheese, cheddar/i, rule_text: 'Cheese, cheddar' },
  { slug: 'olive-oil', query: 'olive oil', rule: /^oil, olive/i, rule_text: 'Oil, olive' },
]
const FOOD_SUBSET = 1500
const must = new Set(FOOD_QUERIES.flatMap((q) => foods.filter((f) => q.rule.test(f.name)).map((f) => f.id)))
const hash = (id: number) => createHash('sha1').update(String(id)).digest('hex')
const fill = foods.filter((f) => !must.has(f.id)).sort((a, b) => hash(a.id).localeCompare(hash(b.id))).slice(0, FOOD_SUBSET - must.size)
const subset = new Set([...must, ...fill.map((f) => f.id)])
const foodItems = foods.filter((f) => subset.has(f.id)).map((f) => ({ id: `f${f.id}`, title: f.category, text: f.name }))

// ---- notes -----------------------------------------------------------------------------------
const notes = (Bun.YAML.parse(readFileSync(join(SUITE, 'notes.yaml'), 'utf8')) as { id: string; title: string; text: string }[])
const NOTE_QUERIES: Query[] = ([
  ['lentil-soup', 'what goes in the lentil soup', ['n09']],
  ['banana-loaf', 'how long to bake the banana loaf', ['n11']],
  ['poached-eggs', 'a dish with eggs poached in tomato sauce', ['n16']],
  ['hike-packing', 'things to pack for a hike', ['n18']],
  ['flight-portugal', 'when does my flight to Portugal arrive', ['n17']],
  ['train-scotland', 'how do I get to Scotland by train', ['n19']],
  ['rental-car', 'what do I need to collect a rental car', ['n21']],
  ['barbell-legs', 'leg exercises with a barbell', ['n25']],
  ['interval-running', 'ideas for interval running', ['n26']],
  ['swimming', 'swimming workout', ['n27']],
  ['long-race-plan', 'training plan for a long race', ['n32']],
  ['teeth-appointment', 'teeth cleaning appointment', ['n33']],
  ['leaking-faucet', 'fix the leaking faucet', ['n34']],
  ['shopping-list', 'shopping list', ['n35']],
  ['passport-photo', 'passport photo requirements', ['n36']],
  ['mother-gift', 'gift ideas for my mother', ['n39']],
  ['habits-book', 'notes on a book about building good habits', ['n41']],
  ['pet-vaccine', 'pet vaccination date', ['n50']],
  ['indoor-plants', 'how to look after my indoor plants', ['n53']],
  ['internet-drops', 'the internet keeps disconnecting', ['n55']],
  ['bike-tyres', 'my bike tyres and brakes', ['n54']],
  ['candidate-feedback', 'feedback on the interview candidate', ['n05']],
  ['oncall', 'who is handling the on-call rota', ['n06']],
  ['cloud-spend', 'cloud spending is too high', ['n02']],
  ['morning-stretch', 'stretching routine for mornings', ['n31']],
] as [string, string, string[]][]).map(([slug, query, relevant]) => ({ slug, query, relevant, how: 'judged by reading' }))

// ---- write -----------------------------------------------------------------------------------
const corpora = {
  photos: photos.map((p) => ({ id: p.id, file: `corpus/${p.file}` })),
  docs: docs.map((d) => ({ id: d.id, file: `corpus/${d.file}` })),
  foods: foodItems,
  notes,
}
const header = [
  '# The candidates each search case is ranked against, by corpus (scripts/pick-search.ts; docs/plans/search.md).',
  '# photos, docs: images (`file`, a path from the repo root). foods, notes: text (`title`, `text`).',
  '# foods is a 1500-food subset of the USDA SR Legacy database (public domain); notes are invented (CC0).',
].join('\n')
writeFileSync(join(SUITE, 'corpora.yaml'), `${header}\n${Object.entries(corpora).map(([k, items]) => `${k}:\n${items.map((i) => `  - ${yaml(i)}`).join('\n')}`).join('\n')}\n`)

mkdirSync(join(SUITE, 'cases'), { recursive: true })
let written = 0
function writeCase(kind: string, corpus: string, q: Query & { rule_text?: string }, ids: Set<string>) {
  const unknown = q.relevant.filter((r) => !ids.has(r))
  if (unknown.length > 0) throw new Error(`${kind}/${q.slug}: relevant ids not in ${corpus}: ${unknown.join(', ')}`)
  if (q.relevant.length === 0) throw new Error(`${kind}/${q.slug}: nothing relevant`)
  const id = `${kind}-${q.slug}`
  const path = join(SUITE, 'cases', `${id}.yaml`)
  if (existsSync(path)) return
  const lines = [
    `description: ${yaml(`search ${kind}: ${q.query} (${q.relevant.length} relevant of ${ids.size})`)}`,
    `metadata: { id: ${id}, kind: ${kind} }`,
    'vars:',
    `  kind: ${kind}`,
    `  corpus: ${corpus}`,
    `  query: ${yaml(q.query)}`,
    `  relevant: ${yaml(q.relevant)}`,
    `  how: ${yaml(q.rule_text ? `rule on the name: ${q.rule_text}` : (q.how ?? ''))}`,
  ]
  writeFileSync(path, `${lines.join('\n')}\n`)
  written++
}
for (const q of PHOTO_QUERIES) writeCase('photos', 'photos', q, photoIds)
for (const q of DOC_QUERIES) writeCase('docs', 'docs', q, docIds)
const foodIds = new Set(foodItems.map((f) => f.id))
for (const q of FOOD_QUERIES) writeCase('text', 'foods', { slug: q.slug, query: q.query, relevant: foods.filter((f) => subset.has(f.id) && q.rule.test(f.name)).map((f) => `f${f.id}`), how: '', rule_text: q.rule_text }, foodIds)
const noteIds = new Set(notes.map((n) => n.id))
for (const q of NOTE_QUERIES) writeCase('text', 'notes', { ...q, slug: `note-${q.slug}` }, noteIds)
console.log(`${written} cases written; corpora: ${Object.entries(corpora).map(([k, v]) => `${k} ${v.length}`).join(', ')}; foods relevant-required ${must.size}`)
