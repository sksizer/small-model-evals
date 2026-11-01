// Builds the food database the food-lookup suite searches: every food in
// USDA FoodData Central's SR Legacy release (public domain, CC0), with its
// energy per 100 g and its household portions ("1 cup, chopped = 160 g").
//
// The release is fixed (April 2018, the final SR Legacy) and its download is
// pinned by sha256, so the database never drifts. The output is
// suites/food-lookup/foods.jsonl, one food per line; it is committed and,
// like a case, never edited once a run has used it.
//
//   bun scripts/build-foods.ts
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnRunner } from '@osdlc/command-seam'
import { ROOT } from './ledger.ts'

const URL_ = 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip'
const SHA256 = 'b80817294b8850530aaedf2e515c02593b1824f763a0ff356e5c2081643e6fd0'
const OUT = join(ROOT, 'suites', 'food-lookup', 'foods.jsonl')
const ENERGY_KCAL = '1008'

export interface Food {
  id: number
  name: string
  category: string
  kcal_100g: number | null
  /** Household measures, e.g. `1 cup, chopped` → 160 g. */
  portions: { measure: string; grams: number }[]
}

/** Parses RFC 4180 CSV (quoted fields, doubled quotes) into rows of strings. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field.replace(/\r$/, ''))
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if (field || row.length > 0) rows.push([...row, field])
  return rows
}

/** A CSV file as objects keyed by its header row. */
function table(dir: string, name: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(readFileSync(join(dir, name), 'utf8'))
  return rows.filter((r) => r.length === header!.length).map((r) => Object.fromEntries(header!.map((h, i) => [h, r[i]!])))
}

const res = await fetch(URL_)
if (!res.ok) throw new Error(`${URL_}: HTTP ${res.status}`)
const zip = new Uint8Array(await res.arrayBuffer())
const got = createHash('sha256').update(zip).digest('hex')
if (got !== SHA256) throw new Error(`download sha256 ${got} does not match the pinned ${SHA256}`)

const work = mkdtempSync(join(tmpdir(), 'sr-legacy-'))
try {
  writeFileSync(join(work, 'sr.zip'), zip)
  const unzip = spawnRunner('unzip').run(['-q', 'sr.zip'], { cwd: work })
  if (unzip.exitCode !== 0) throw new Error(`unzip failed: ${unzip.stderr}`)
  const dir = join(work, readdirSync(work).find((f) => f.startsWith('FoodData_Central'))!)

  const categories = new Map(table(dir, 'food_category.csv').map((c) => [c['id']!, c['description']!]))
  const kcal = new Map(
    table(dir, 'food_nutrient.csv')
      .filter((n) => n['nutrient_id'] === ENERGY_KCAL)
      .map((n) => [n['fdc_id']!, Number(n['amount'])]),
  )
  const portions = new Map<string, Food['portions']>()
  for (const p of table(dir, 'food_portion.csv').sort((a, b) => Number(a['seq_num']) - Number(b['seq_num']))) {
    // SR Legacy leaves measure_unit_id undetermined and writes the unit into
    // `modifier` ("cup, chopped"), with the count in `amount`.
    const measure = `${Number(p['amount'])} ${p['modifier']}`.trim()
    const list = portions.get(p['fdc_id']!) ?? []
    list.push({ measure, grams: Number(p['gram_weight']) })
    portions.set(p['fdc_id']!, list)
  }
  const foods: Food[] = table(dir, 'food.csv')
    .map((f) => ({
      id: Number(f['fdc_id']),
      name: f['description']!,
      category: categories.get(f['food_category_id']!) ?? '',
      kcal_100g: kcal.get(f['fdc_id']!) ?? null,
      portions: portions.get(f['fdc_id']!) ?? [],
    }))
    .sort((a, b) => a.id - b.id)
  writeFileSync(OUT, foods.map((f) => JSON.stringify(f)).join('\n') + '\n')
  console.log(`${foods.length} foods → ${OUT}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
