// promptfoo `javascript` assertion for the food-lookup suite, and the
// per-item comparison the results site shows.
//
// The reply (providers/ollama-food-agent.ts) is `{"answer": {"items": [...]},
// "searches": [...]}`; each item is `text` (the note's words for it),
// `fdc_id` (a food from the database) and `grams`. `vars.expected` lists the
// foods the note says were eaten:
//
//   expected:
//     - { text: [egg], food: [egg], kcal_100g: 143, grams: { approx: 100, tol: 15 } }
//     - { text: [oat milk], fdc_id: null }          # not in the database
//
// Several database entries are often equally right (whole milk with or
// without added vitamin D), so the scorer does not ask for one id. The chosen
// food counts when its name contains one of the `food` words and its energy
// per 100 g is within 20% (or 10 kcal) of `kcal_100g`, the reference entry's.
// The id must exist in the database, so an invented id never counts.
//
// An item is matched to an expectation by its `text` (tag-style, see
// assertions/tags.ts). Each expectation scores half for the food and half
// for the grams (any match.ts matcher); a `fdc_id: null` expectation scores
// whole when the model gives no id. Each item the note does not call for is
// one failed item. Passes at 0.8.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { matches, parseJson, type Expected, type GradingResult } from './match.ts'
import { tagMatches, type Concept } from './tags.ts'

const PASS_AT = 0.8
const DB = join(import.meta.dirname, '..', 'suites', 'food-lookup', 'foods.jsonl')

export interface ExpectedFood {
  text: Concept
  food?: string[]
  kcal_100g?: number
  grams?: Expected
  fdc_id?: null
}

interface Item {
  text?: unknown
  fdc_id?: unknown
  grams?: unknown
}

let foods: Map<number, { name: string; kcal_100g: number | null }> | null = null
function food(id: unknown) {
  if (!foods) {
    foods = new Map(
      readFileSync(DB, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { id: number; name: string; kcal_100g: number | null })
        .map((f) => [f.id, f]),
    )
  }
  return typeof id === 'number' ? foods.get(id) : undefined
}

export interface FoodRow {
  field: string
  want: string
  got: string
  ok: boolean
  score: number
}

const label = (c: Concept) => (Array.isArray(c) ? c[0]! : c)
const showWant = (e: ExpectedFood) =>
  e.fdc_id === null ? 'no match in the database' : `${(e.food ?? []).join(' / ')} ~${e.kcal_100g} kcal/100 g · ${JSON.stringify(e.grams)} g`
const showGot = (i: Item) => {
  const f = food(i.fdc_id)
  return `${i.fdc_id === null ? 'no id' : f ? `${f.name} (${f.kcal_100g} kcal/100 g)` : `unknown id ${String(i.fdc_id)}`} · ${String(i.grams)} g`
}

/** The searches and items in a reply, or null when it does not parse. */
export function parseReply(output: unknown): { items: Item[]; searches: string[] } | null {
  const reply = parseJson(output) as { answer?: { items?: unknown }; searches?: unknown } | undefined
  const items = reply?.answer?.items
  if (!Array.isArray(items)) return null
  return { items: items as Item[], searches: Array.isArray(reply?.searches) ? (reply.searches as string[]) : [] }
}

export function compareFood(expected: ExpectedFood[], output: unknown): FoodRow[] | null {
  const reply = parseReply(output)
  if (!reply) return null
  const used = new Set<number>()
  const rows: FoodRow[] = []
  for (const want of expected) {
    const i = reply.items.findIndex((it, j) => !used.has(j) && typeof it.text === 'string' && tagMatches(want.text, [it.text]))
    if (i < 0) {
      rows.push({ field: label(want.text), want: showWant(want), got: 'missing', ok: false, score: 0 })
      continue
    }
    used.add(i)
    const it = reply.items[i]!
    let score: number
    if (want.fdc_id === null) score = it.fdc_id === null || it.fdc_id === undefined ? 1 : 0
    else {
      const f = food(it.fdc_id)
      const ref = want.kcal_100g ?? 0
      const foodOk =
        !!f &&
        (want.food ?? []).some((w) => f.name.toLowerCase().includes(w.toLowerCase())) &&
        f.kcal_100g !== null &&
        Math.abs(f.kcal_100g - ref) <= Math.max(10, ref * 0.2)
      const gramsOk = want.grams === undefined ? true : matches(want.grams, it.grams)
      score = (foodOk ? 0.5 : 0) + (gramsOk ? 0.5 : 0)
    }
    rows.push({ field: label(want.text), want: showWant(want), got: showGot(it), ok: score === 1, score })
  }
  reply.items.forEach((it, j) => {
    if (!used.has(j)) rows.push({ field: `extra: ${String(it.text)}`, want: 'not in the note', got: showGot(it), ok: false, score: 0 })
  })
  return rows
}

export function gradeFood(expected: ExpectedFood[], output: unknown): GradingResult {
  const rows = compareFood(expected, output)
  if (!rows) return { pass: false, score: 0, reason: 'reply has no answer.items list' }
  const searches = parseReply(output)?.searches.length ?? 0
  const score = rows.length === 0 ? 1 : rows.reduce((a, r) => a + r.score, 0) / rows.length
  const misses = rows.filter((r) => !r.ok).map((r) => `${r.field}: wanted ${r.want}, got ${r.got}`)
  return {
    pass: score >= PASS_AT,
    score,
    reason: `${searches} searches; ${misses.length === 0 ? 'every item matches' : misses.join('; ')}`,
  }
}

export default function (output: unknown, context: { vars: { expected: ExpectedFood[] } }): GradingResult {
  return gradeFood(context.vars.expected, output)
}
