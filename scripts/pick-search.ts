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
//   derived copies, nor the synthetic pages): 78 images. The first 25 photo queries (2026-11-05)
//   run on it.
// - photos-dup: those 78 plus every derived copy (resized, cropped, flipped, brightened or
//   recompressed, scripts/recipes.ts) of one of them: near-duplicates the model must not lose
//   (a copy of a relevant photo is relevant) nor confuse with a different photo of the same kind.
//   The hard photo queries (2026-11-08) run on it. Copies of the synthetic pages are not in it.
// - docs: the 44 synthetic pages (corpus/images/*.png: cards, statements, letters,
//   screenshots), searched as images.
// - foods: all 7793 USDA SR Legacy foods (public domain), since 2026-11-08 (before: a 1500-food
//   subset, which made the distractors too few and too unlike the answers).
// - notes: 88 invented notes (suites/search/notes.yaml, CC0): the 60 of 2026-11-05 plus 28 hard
//   distractors written 2026-11-08 (n61 to n88: same topic, not the answer).
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
//   the case lists the ids that match.
// - notes: judged by reading; a query lists the one or two notes that answer it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { csvLine, OI_CACHE } from './openimages.ts'
import { ROOT, SUITES_DIR } from './ledger.ts'
import { HARD_NOTE_SLUGS } from './search-sets.ts'

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
/** Derived copies (`copy-<recipe>-<parent id>`) of the photos above, by parent id. */
const copiesOf = new Map<string, string[]>()
const copyEntries = manifest.filter((m) => m.category === 'similarity-copy' && !m.sensitive)
for (const c of copyEntries) {
  const parent = /^copy-[a-z0-9]+-(.+)$/.exec(c.id)?.[1]
  if (parent && photoIds.has(parent)) copiesOf.set(parent, [...(copiesOf.get(parent) ?? []), c.id])
}
const dupPhotos = [...photos, ...copyEntries.filter((c) => [...copiesOf.values()].some((l) => l.includes(c.id)))]
const dupIds = new Set(dupPhotos.map((p) => p.id))
/** A copy of a relevant photo is relevant: it shows the same thing. */
const withCopies = (ids: string[]): string[] => [...new Set(ids.flatMap((i) => [i, ...(copiesOf.get(i) ?? [])]))].sort()

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

/**
 * The hard photo queries (2026-11-08), over photos-dup: the 13 object queries again (so the near-duplicate
 * copies count as relevant), then fine-grained descriptions whose nearest distractors are other photos of
 * the same kind (another watch, another dog, another coffee). Judged by eye, from the contact sheets.
 */
const eyeDup = (ids: string[]) => ({ relevant: withCopies(eye(ids).relevant), how: 'judged by eye; copies of a relevant photo count' })
const PHOTO_DUP_QUERIES: Query[] = [
  ...PHOTO_QUERIES.filter((q) => q.how?.startsWith('Open Images')).map((q) => ({ ...q, relevant: withCopies(q.relevant), how: `${q.how}; copies of a relevant photo count` })),
  { slug: 'black-dial-watch', query: 'a wristwatch with a black dial and a steel bracelet', ...eyeDup(['find-66a342dcdafc7607']) },
  { slug: 'white-dial-watch', query: 'a chronograph watch with a white dial and a leather strap', ...eyeDup(['find-149a74e86e8161a5']) },
  { slug: 'dog-sunglasses', query: 'a dog wearing sunglasses', ...eyeDup(['find-030c5a10124e6252']) },
  { slug: 'red-car-grass', query: 'a vintage red convertible parked on grass', ...eyeDup(['scene-spitfire-a', 'scene-spitfire-b']) },
  { slug: 'road-cyclist', query: 'a cyclist riding a road bike', ...eyeDup(['find-6022a450df278025', 'find-8f08cb18c27fbaa7']) },
  { slug: 'bike-against-wall', query: 'a black bicycle leaning against a wall', ...eyeDup(['objects-2fba54286aaac20e']) },
  { slug: 'bikes-in-rack', query: 'many bicycles in a rack', ...eyeDup(['bike-parking-oakland']) },
  { slug: 'black-coffee', query: 'a cup of dark coffee next to a small bowl', ...eyeDup(['objects-25d107f1590c1772']) },
  { slug: 'cappuccino-phone', query: 'a cappuccino next to a phone and earphones', ...eyeDup(['coffee-shop-counter']) },
  { slug: 'dog-in-bed', query: 'a small dog sleeping in a dog bed', ...eyeDup(['dog-in-dog-bed']) },
  { slug: 'dog-paws-up', query: 'a dog lying on its back with its paws in the air', ...eyeDup(['dog-border-terrier']) },
  { slug: 'dog-sunny-pavement', query: 'a white and tan dog asleep on sunny paving', ...eyeDup(['dog-autumn-sun']) },
  { slug: 'basset-window', query: 'a basset hound by a window', ...eyeDup(['objects-d8cac8b54e9fa89c']) },
  { slug: 'spaniels-grass', query: 'two black and white dogs lying on the grass', ...eyeDup(['objects-5b7ab3baf4c0492f']) },
  { slug: 'hot-tub', query: 'a hot tub in a small room with a plant', ...eyeDup(['objects-eccb080e57b2aac5']) },
  { slug: 'black-pen', query: 'a black pen on a white background', ...eyeDup(['find-2dcab96f79ef52c4']) },
  { slug: 'pencil-grid', query: 'a mechanical pencil on grid paper', ...eyeDup(['find-07caab7b663b7e86']) },
  { slug: 'old-envelope', query: 'an old envelope with a postmark', ...eyeDup(['find-0f730eda466be34c']) },
  { slug: 'beige-armchair', query: 'a beige armchair with a patterned cushion', ...eyeDup(['objects-ee47ccab89a75d0d']) },
  { slug: 'grey-armchairs', query: 'two grey armchairs in a living room', ...eyeDup(['objects-5ea13fbbd1a1474f']) },
  { slug: 'floor-lamp-sofa', query: 'a floor lamp next to a teal sofa', ...eyeDup(['find-e916dd0b766b2f40']) },
  { slug: 'pendant-lamps', query: 'pendant lamps with letters cut into them', ...eyeDup(['find-743dbcab02a9971e']) },
  { slug: 'filament-bulb', query: 'a glowing filament light bulb', ...eyeDup(['find-a90c22661fe961ff']) },
  { slug: 'car-front-plate', query: 'the front of a black car with a number plate', ...eyeDup(['objects-28bd6c6b1050e055']) },
  { slug: 'old-laptop-terminal', query: 'an old white laptop showing a terminal window', ...eyeDup(['objects-a7e5d2727af4299d']) },
  { slug: 'laptop-yellow-flowers', query: 'a white laptop with yellow flowers and a takeaway cup', ...eyeDup(['desk-coffee-laptop-notebook']) },
  { slug: 'ukulele', query: 'a ukulele', ...eyeDup(['find-29de4e35add89b69']) },
  { slug: 'fretboard-hand', query: 'a hand pressing strings on a guitar neck', ...eyeDup(['find-c4d62e55691ed1e4']) },
  { slug: 'grilled-sandwich', query: 'a grilled sandwich with cucumber and tomato slices', ...eyeDup(['coffee-snacks-table']) },
  { slug: 'whipped-pancakes', query: 'pancakes with whipped cream and berries', ...eyeDup(['pancakes-stack']) },
  { slug: 'caprese', query: 'tomato and mozzarella salad with basil', ...eyeDup(['salad-party-dish']) },
  { slug: 'pasta-arugula', query: 'pasta with cherry tomatoes and arugula', ...eyeDup(['salad-rucola-plate']) },
  { slug: 'turquoise-reservoir', query: 'a turquoise reservoir behind a dam in the mountains', ...eyeDup(['mountain-lake-dam']) },
  { slug: 'mirror-lake', query: 'snowy peaks reflected in a still lake', ...eyeDup(['lake-sherburne']) },
  { slug: 'lone-tree-dusk', query: 'a lone tree on the shore at dusk', ...eyeDup(['sunset-beach-colonia']) },
  { slug: 'trunk-fungus', query: 'fungus growing on a tree trunk', ...eyeDup(['tree-bracket-fungus']) },
  { slug: 'millipede', query: 'a millipede on mossy rocks', ...eyeDup(['millipede-moss']) },
  { slug: 'chinese-ticket', query: 'a train ticket in Chinese with a QR code', ...eyeDup(['train-ticket-chinese']) },
  { slug: 'farmhouse-horses', query: 'horses near a white farmhouse at dusk', ...eyeDup(['horses-pasture-house']) },
  { slug: 'hydrant-sign', query: 'a red hydrant sign', ...eyeDup(['find-01d3fdb0f6383edb']) },
  // Added the same day after the first run showed the single-answer queries above are easy for the image-text
  // models: counts, relations, categories and negations, several relevant photos each, none named by a distinctive noun.
  { slug: 'two-dogs', query: 'two dogs together', ...eyeDup(['objects-0fd512f1bffb8cf3', 'objects-5b7ab3baf4c0492f']) },
  { slug: 'laptop-and-notebook', query: 'a laptop and a notebook on a desk', ...eyeDup(['desk-laptop-notebook-pen', 'desk-coffee-laptop-notebook', 'laptop-notepad', 'desk-laptop-top-down']) },
  { slug: 'person-on-bicycle', query: 'a person riding a bicycle', ...eyeDup(['find-6022a450df278025', 'find-8f08cb18c27fbaa7']) },
  { slug: 'red-car', query: 'a red car', ...eyeDup(['scene-spitfire-a', 'scene-spitfire-b', 'scene-monaco-a', 'scene-monaco-b']) },
  { slug: 'tomato-food', query: 'food with tomatoes', ...eyeDup(['salad-party-dish', 'salad-rucola-plate', 'coffee-snacks-table']) },
  { slug: 'night-scene', query: 'a scene at night', ...eyeDup(['diner-snow-night', 'street-night-rostov', 'railway-station-dark']) },
  { slug: 'snow-ground', query: 'snow on the ground', ...eyeDup(['snow-forest-trail', 'diner-snow-night']) },
  { slug: 'not-a-dog', query: 'an animal that is not a dog', ...eyeDup(['horses-flooded-pasture', 'horses-pasture-house', 'parrot-illustration', 'millipede-moss']) },
  { slug: 'handwriting', query: 'a handwritten page', ...eyeDup(['letter-handwritten-short', 'recipe-daffys-elixir', 'recipe-rheumatism']) },
  { slug: 'strings', query: 'a musical instrument with strings', ...eyeDup(['find-c4d62e55691ed1e4', 'find-29de4e35add89b69']) },
  { slug: 'worn-on-wrist', query: 'something you wear on your wrist', ...eyeDup(['find-66a342dcdafc7607', 'find-149a74e86e8161a5']) },
  { slug: 'tickets', query: 'a travel ticket', ...eyeDup(['train-ticket-chinese', 'train-ticket-french']) },
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

/**
 * Fine-grained document queries (2026-11-08): they describe a page's content or its look, and the pages
 * that look most like it (another card, another statement, a blank template, a public page) are in the
 * corpus. Judged from each page's HTML source in corpus/synthetic/.
 */
const DOC_FINE_QUERIES: Query[] = ([
  { slug: 'fine-rent-october', query: 'rent paid in October', relevant: ['bank-statement'] },
  { slug: 'fine-electricity-kwh', query: 'charges for 312 kWh of electricity', relevant: ['utility-bill'] },
  { slug: 'fine-deductions', query: 'pension and National Insurance deductions', relevant: ['pay-slip'] },
  { slug: 'fine-mugs-invoice', query: 'an invoice for stoneware mugs and serving bowls', relevant: ['invoice-simple'] },
  { slug: 'fine-oat-milk-receipt', query: 'a receipt listing oat milk, sourdough and bananas', relevant: ['receipt-grocery'] },
  { slug: 'fine-cardiologist', query: 'a clinic letter referring a patient to a cardiologist', relevant: ['referral-letter'] },
  { slug: 'fine-tenancy', query: 'a twelve-month tenancy agreement', relevant: ['rental-contract'] },
  { slug: 'fine-lock-screen', query: 'a phone lock screen with notifications about a card purchase', relevant: ['lock-screen-notifications'] },
  { slug: 'fine-contacts', query: 'a phone contact list with names and addresses', relevant: ['contacts-list'] },
  { slug: 'fine-inbox-doctor', query: 'an email inbox with a message from a doctor about test results', relevant: ['email-inbox'] },
  { slug: 'fine-failed-jobs', query: 'a dashboard of failed background jobs', relevant: ['jobs-table'] },
  { slug: 'fine-sync-settings', query: 'sync settings for cellular data and deleted items', relevant: ['settings-panel'] },
  { slug: 'fine-mobile-banking', query: 'a mobile banking app showing account balances', relevant: ['online-banking-screen'] },
  { slug: 'fine-hba1c', query: 'a lab report with blood sugar and cholesterol', relevant: ['lab-result'] },
  { slug: 'fine-copay', query: 'a health plan member card with copay amounts', relevant: ['health-insurance-card'] },
  { slug: 'fine-blank-template', query: 'a blank ID card template with no personal data', relevant: ['id-card-blank-template'] },
  { slug: 'fine-residence-permit', query: 'a residence permit for a foreign worker', relevant: ['residence-permit-card'] },
  { slug: 'fine-skillet-page', query: 'a product page for a cast iron skillet', relevant: ['product-page-phone'] },
  { slug: 'fine-sale-newsletter', query: 'a summer sale newsletter', relevant: ['marketing-email'] },
  { slug: 'fine-alarm-code', query: 'a handwritten note with an alarm code', relevant: ['handwritten-note'] },
  { slug: 'fine-env-secrets', query: 'a terminal showing environment variables with secret keys', relevant: ['terminal-api-key'] },
  { slug: 'fine-seat-23a', query: 'a boarding pass for seat 23A', relevant: ['boarding-pass'] },
  { slug: 'fine-house-letter', query: 'a personal letter about selling a mother\'s house', relevant: ['letter-personal'] },
  { slug: 'fine-surprise-chat', query: 'a chat about a surprise and a door code', relevant: ['chat-screenshot'] },
  { slug: 'fine-week-calendar', query: 'a weekly calendar with a mediation and a hospital appointment', relevant: ['calendar-private'] },
  { slug: 'fine-student-card', query: 'a student ID card', relevant: ['student-id-card'] },
] as Query[]).map((q) => ({ ...q, how: 'judged from the page source' }))

// ---- foods -----------------------------------------------------------------------------------
interface Food { id: number; name: string; category: string }
const foods = readFileSync(join(SUITES_DIR, 'food-lookup', 'foods.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Food)
/**
 * Each query's rule on the food's name, applied to the whole database (all 7793 foods are the corpus).
 * The first 15 are the 2026-11-05 queries again (their old cases ran over a 1500-food subset and are retired);
 * the rest (2026-11-08) are paraphrases (aubergine, courgette, rocket, icing sugar), negations (unsalted,
 * unsweetened, decaffeinated, no salt added) and near-misses (whole against low-fat milk, raw against
 * cooked, with against without skin) whose distractors are the neighbouring entries.
 */
const FOOD_QUERIES: { slug: string; query: string; rule: RegExp; rule_text: string; supersedes?: string }[] = [
  { slug: 'raw-spinach', query: 'raw spinach', rule: /^spinach, raw\b/i, rule_text: 'name starts "Spinach, raw"', supersedes: 'text-raw-spinach' },
  { slug: 'greek-yogurt', query: 'low-fat greek yogurt', rule: /^yogurt, greek.*(lowfat|nonfat)/i, rule_text: 'Yogurt, Greek, lowfat or nonfat', supersedes: 'text-greek-yogurt' },
  { slug: 'chicken-thigh', query: 'boneless chicken thigh, roasted', rule: /^chicken\b.*thigh, meat (only|and skin).*roasted/i, rule_text: 'chicken, thigh, meat only or meat and skin (no bone), roasted', supersedes: 'text-chicken-thigh' },
  { slug: 'hard-boiled-egg', query: 'hard-boiled egg', rule: /^egg\b.*hard-boiled/i, rule_text: 'egg, hard-boiled', supersedes: 'text-hard-boiled-egg' },
  { slug: 'brown-rice', query: 'cooked brown rice', rule: /^rice, brown,.*\bcooked\b/i, rule_text: 'Rice, brown, ... cooked', supersedes: 'text-brown-rice' },
  { slug: 'skim-milk', query: 'skim milk', rule: /^milk, nonfat, fluid/i, rule_text: 'Milk, nonfat, fluid (fat free or skim)', supersedes: 'text-skim-milk' },
  { slug: 'lean-beef', query: 'extra lean ground beef, 95%', rule: /^beef, ground, 95%/i, rule_text: 'Beef, ground, 95% lean', supersedes: 'text-lean-beef' },
  { slug: 'wholewheat-bread', query: 'whole wheat bread', rule: /^bread, whole-wheat/i, rule_text: 'Bread, whole-wheat', supersedes: 'text-wholewheat-bread' },
  { slug: 'baked-potato', query: 'baked potato', rule: /^potatoes, baked/i, rule_text: 'Potatoes, baked', supersedes: 'text-baked-potato' },
  { slug: 'firm-tofu', query: 'firm tofu', rule: /^tofu, (raw, )?firm/i, rule_text: 'Tofu, firm', supersedes: 'text-firm-tofu' },
  { slug: 'cooked-lentils', query: 'boiled lentils', rule: /^lentils\b.*cooked, boiled/i, rule_text: 'Lentils, ... cooked, boiled', supersedes: 'text-cooked-lentils' },
  { slug: 'avocado', query: 'avocado', rule: /^avocados, raw/i, rule_text: 'Avocados, raw', supersedes: 'text-avocado' },
  { slug: 'canned-tuna', query: 'canned tuna in water', rule: /^fish, tuna.*canned in water/i, rule_text: 'Fish, tuna, canned in water', supersedes: 'text-canned-tuna' },
  { slug: 'cheddar', query: 'cheddar cheese', rule: /^cheese, cheddar/i, rule_text: 'Cheese, cheddar', supersedes: 'text-cheddar' },
  { slug: 'olive-oil', query: 'olive oil', rule: /^oil, olive/i, rule_text: 'Oil, olive', supersedes: 'text-olive-oil' },
  // near-misses: the neighbouring entries differ in one word
  { slug: 'whole-milk', query: 'whole milk', rule: /^milk, whole, 3\.25%/i, rule_text: 'Milk, whole, 3.25% milkfat' },
  { slug: 'lowfat-milk', query: 'low-fat milk, 1 percent', rule: /^milk, lowfat, fluid, 1%/i, rule_text: 'Milk, lowfat, fluid, 1% milkfat' },
  { slug: 'reduced-fat-milk', query: 'two percent reduced fat milk', rule: /^milk, reduced fat, fluid, 2%/i, rule_text: 'Milk, reduced fat, fluid, 2% milkfat' },
  { slug: 'raw-broccoli', query: 'raw broccoli', rule: /^broccoli, (flower clusters, )?raw$/i, rule_text: 'Broccoli, raw (or flower clusters, raw)' },
  { slug: 'boiled-broccoli', query: 'boiled broccoli, drained', rule: /^broccoli, (frozen, (chopped|spears), )?cooked, boiled, drained/i, rule_text: 'Broccoli, (frozen, chopped or spears,) cooked, boiled, drained' },
  { slug: 'raw-carrots', query: 'raw carrots', rule: /^carrots, (baby, )?raw$/i, rule_text: 'Carrots, raw (or baby, raw)' },
  { slug: 'cooked-carrots', query: 'cooked carrots', rule: /^carrots, (frozen, )?cooked, boiled, drained/i, rule_text: 'Carrots, (frozen,) cooked, boiled, drained' },
  { slug: 'boiled-carrots-no-salt', query: 'boiled carrots without salt', rule: /^carrots, (frozen, )?cooked, boiled, drained, without salt/i, rule_text: 'Carrots, (frozen,) cooked, boiled, drained, without salt' },
  { slug: 'canned-carrots-no-salt', query: 'canned carrots with no salt added', rule: /^carrots, canned, no salt added/i, rule_text: 'Carrots, canned, no salt added' },
  { slug: 'apple-with-skin', query: 'an apple, raw, with the skin on', rule: /^apples, raw, ([a-z ]+, )?with skin/i, rule_text: 'Apples, raw, (variety,) with skin' },
  { slug: 'apple-peeled', query: 'a peeled raw apple', rule: /^apples, raw, without skin$/i, rule_text: 'Apples, raw, without skin' },
  { slug: 'raw-egg', query: 'raw whole egg', rule: /^egg, whole, raw, fresh/i, rule_text: 'Egg, whole, raw, fresh' },
  { slug: 'fried-egg', query: 'fried egg', rule: /^egg, whole, cooked, fried/i, rule_text: 'Egg, whole, cooked, fried' },
  { slug: 'scrambled-egg', query: 'scrambled eggs', rule: /^egg, whole, cooked, scrambled/i, rule_text: 'Egg, whole, cooked, scrambled' },
  { slug: 'white-rice-cooked', query: 'cooked long-grain white rice', rule: /^rice, white, long-grain, regular, (enriched, cooked|cooked, unenriched)/i, rule_text: 'Rice, white, long-grain, regular, cooked' },
  { slug: 'chicken-breast-skinless', query: 'roasted chicken breast without skin', rule: /^chicken, broilers or fryers, breast, meat only, cooked, roasted/i, rule_text: 'chicken, broilers or fryers, breast, meat only, cooked, roasted' },
  { slug: 'chicken-breast-skin', query: 'roasted chicken breast with the skin', rule: /^chicken, broilers or fryers, breast, meat and skin, cooked, roasted/i, rule_text: 'chicken, broilers or fryers, breast, meat and skin, cooked, roasted' },
  { slug: 'sweet-potato-baked', query: 'baked sweet potato', rule: /^sweet potato, cooked, baked in skin/i, rule_text: 'Sweet potato, cooked, baked in skin' },
  { slug: 'dry-roasted-almonds', query: 'dry roasted almonds, unsalted', rule: /^nuts, almonds, dry roasted, without salt/i, rule_text: 'Nuts, almonds, dry roasted, without salt added' },
  // negation
  { slug: 'unsalted-butter', query: 'unsalted butter', rule: /^butter, without salt/i, rule_text: 'Butter, without salt' },
  { slug: 'unsweetened-applesauce', query: 'unsweetened applesauce', rule: /^applesauce, canned, unsweetened/i, rule_text: 'Applesauce, canned, unsweetened' },
  { slug: 'decaf-coffee', query: 'decaffeinated coffee', rule: /^beverages, coffee.*decaffeinated/i, rule_text: 'Beverages, coffee, ... decaffeinated' },
  { slug: 'no-salt-tomato-sauce', query: 'tomato sauce with no salt added', rule: /^tomato sauce, canned, no salt added/i, rule_text: 'Tomato sauce, canned, no salt added' },
  { slug: 'low-sodium-soy', query: 'low sodium soy sauce', rule: /^soy sauce.*(low sodium|reduced sodium)/i, rule_text: 'Soy sauce, low or reduced sodium' },
  // paraphrase: another name for the same food
  { slug: 'aubergine', query: 'aubergine', rule: /^eggplant, (raw|cooked)/i, rule_text: 'Eggplant, raw or cooked' },
  { slug: 'courgette', query: 'courgette', rule: /zucchini/i, rule_text: 'name contains zucchini' },
  { slug: 'rocket', query: 'rocket leaves', rule: /^arugula/i, rule_text: 'Arugula' },
  { slug: 'spring-onions', query: 'spring onions', rule: /^onions, spring or scallions/i, rule_text: 'Onions, spring or scallions' },
  { slug: 'red-capsicum', query: 'raw red capsicum', rule: /^peppers, sweet, red, raw/i, rule_text: 'Peppers, sweet, red, raw' },
  { slug: 'coriander', query: 'fresh coriander leaves', rule: /^coriander \(cilantro\) leaves, raw/i, rule_text: 'Coriander (cilantro) leaves, raw' },
  { slug: 'garbanzo-canned', query: 'tinned chickpeas', rule: /^chickpeas.*canned/i, rule_text: 'Chickpeas (garbanzo beans), canned' },
  { slug: 'icing-sugar', query: 'icing sugar', rule: /^sugars, powdered/i, rule_text: 'Sugars, powdered' },
  { slug: 'plain-flour', query: 'plain white flour', rule: /^wheat flour, white, all-purpose/i, rule_text: 'Wheat flour, white, all-purpose' },
]
const foodItems = foods.map((f) => ({ id: `f${f.id}`, title: f.category, text: f.name }))

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

/**
 * Hard note queries (2026-11-08): each has a look-alike among the notes (the hard distractors n61 to n88:
 * a salad for a soup, Madrid for Portugal, a car service for a car rental, a plant sale for plant care),
 * or is a paraphrase or a negation of what the note says.
 */
const NOTE_HARD_QUERIES: Query[] = ([
  ['cold-lentil-dish', 'a cold lentil dish, not a soup', ['n61']],
  ['no-cook-breakfast', 'a quick breakfast that needs no cooking', ['n14', 'n62']],
  ['flight-madrid', 'when does my flight to Madrid land', ['n66']],
  ['hire-car', 'what to bring to pick up a hire car', ['n21']],
  ['car-insurance', 'quote for the car insurance renewal', ['n71']],
  ['dumbbell-day', 'a workout with only dumbbells', ['n72']],
  ['hose-connector', 'attaching a garden hose to the outside tap', ['n77']],
  ['marathon-signup', 'when does marathon sign-up open', ['n75']],
  ['optician', 'what to bring to the optician', ['n76']],
  ['pet-travel', 'travel certificate for the pet', ['n79']],
  ['mum-dinner', 'where is the birthday dinner for mum', ['n80']],
  ['focus-book', 'a book about focus and avoiding distractions', ['n81']],
  ['mesh-wifi', 'buying a mesh wifi system', ['n83']],
  ['stolen-bike', 'what to do after my bike is stolen', ['n84']],
  ['pager-app', 'installing the new pager app', ['n86']],
  ['cloud-exam', 'when is the cloud exam', ['n87']],
  ['evening-wind-down', 'wind-down routine before bed', ['n88']],
  ['interview-schedule', 'who is interviewing on Monday', ['n85']],
] as [string, string, string[]][]).map(([slug, query, relevant]) => ({ slug, query, relevant, how: 'judged by reading' }))

// ---- write -----------------------------------------------------------------------------------
const corpora = {
  photos: photos.map((p) => ({ id: p.id, file: `corpus/${p.file}` })),
  'photos-dup': dupPhotos.map((p) => ({ id: p.id, file: `corpus/${p.file}` })),
  docs: docs.map((d) => ({ id: d.id, file: `corpus/${d.file}` })),
  foods: foodItems,
  notes,
}
const header = [
  '# The candidates each search case is ranked against, by corpus (scripts/pick-search.ts; docs/plans/search.md).',
  '# photos, docs: images (`file`, a path from the repo root). foods, notes: text (`title`, `text`).',
  '# foods is all 7793 foods of the USDA SR Legacy database (public domain); notes are invented (CC0). photos-dup is photos plus their derived copies.',
].join('\n')
writeFileSync(join(SUITE, 'corpora.yaml'), `${header}\n${Object.entries(corpora).map(([k, items]) => `${k}:\n${items.map((i) => `  - ${yaml(i)}`).join('\n')}`).join('\n')}\n`)

mkdirSync(join(SUITE, 'cases'), { recursive: true })
let written = 0
function writeCase(kind: string, corpus: string, q: Query & { rule_text?: string; supersedes?: string }, ids: Set<string>) {
  const unknown = q.relevant.filter((r) => !ids.has(r))
  if (unknown.length > 0) throw new Error(`${kind}/${q.slug}: relevant ids not in ${corpus}: ${unknown.join(', ')}`)
  if (q.relevant.length === 0) throw new Error(`${kind}/${q.slug}: nothing relevant`)
  const id = `${kind}-${q.slug}`
  const path = join(SUITE, 'cases', `${id}.yaml`)
  if (existsSync(path)) return
  const lines = [
    `description: ${yaml(`search ${kind}: ${q.query} (${q.relevant.length} relevant of ${ids.size})`)}`,
    `metadata: { id: ${id}, kind: ${kind}${q.supersedes ? `, supersedes: ${q.supersedes}` : ''} }`,
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
for (const q of PHOTO_DUP_QUERIES) writeCase('photos', 'photos-dup', { ...q, slug: `dup-${q.slug}` }, dupIds)
for (const q of DOC_QUERIES) writeCase('docs', 'docs', q, docIds)
for (const q of DOC_FINE_QUERIES) writeCase('docs', 'docs', q, docIds)
const foodIds = new Set(foodItems.map((f) => f.id))
for (const q of FOOD_QUERIES) {
  writeCase('text', 'foods', { slug: `food-${q.slug}`, query: q.query, relevant: foods.filter((f) => q.rule.test(f.name)).map((f) => `f${f.id}`), how: '', rule_text: q.rule_text, ...(q.supersedes ? { supersedes: q.supersedes } : {}) }, foodIds)
}
const noteIds = new Set(notes.map((n) => n.id))
for (const q of NOTE_QUERIES) writeCase('text', 'notes', { ...q, slug: `note-${q.slug}` }, noteIds)
if (NOTE_HARD_QUERIES.map((q) => q.slug).join() !== HARD_NOTE_SLUGS.join()) throw new Error('NOTE_HARD_QUERIES and HARD_NOTE_SLUGS (scripts/search-sets.ts) disagree')
for (const q of NOTE_HARD_QUERIES) writeCase('text', 'notes', { ...q, slug: `note-${q.slug}` }, noteIds)
console.log(`${written} cases written; corpora: ${Object.entries(corpora).map(([k, v]) => `${k} ${v.length}`).join(', ')}`)
