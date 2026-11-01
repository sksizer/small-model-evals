// The food query system the food-lookup suite's model calls as a tool: plain
// keyword search over suites/food-lookup/foods.jsonl (USDA SR Legacy). No
// model behind it, so the same query always returns the same foods.
//
// Ranking: each query word that appears in a food's name scores a point, two
// if it is in the name's first segment (USDA names lead with the food:
// "Milk, whole, 3.25% milkfat"), plus one if it is the name's first word;
// every name word the query does not mention costs a tenth, so plain entries
// beat elaborate ones. Ties go to the lower id. Words are lower-cased and a
// plural `s`/`es` is dropped.
//
//   bun providers/food-search.ts "whole milk"     # try a query
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Food {
  id: number
  name: string
  category: string
  kcal_100g: number | null
  portions: { measure: string; grams: number }[]
}

/** What the tool returns per food: enough to pick one and convert an amount. */
export interface Hit {
  fdc_id: number
  name: string
  kcal_per_100g: number | null
  portions: string[]
}

const RESULTS = 10
const PORTIONS = 6

/** Drops a plural ending: berries → berry, tomatoes → tomato, apples → apple. */
function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`
  if (w.length > 4 && /(ch|sh|x|o)es$/.test(w)) return w.slice(0, -2)
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1)
  return w
}
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9%]+/).filter(Boolean).map(stem)

let cache: { food: Food; all: Set<string>; head: Set<string>; first: string }[] | null = null

function index(path: string) {
  if (!cache) {
    cache = readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const food = JSON.parse(line) as Food
        return { food, all: new Set(words(food.name)), head: new Set(words(food.name.split(',')[0]!)), first: words(food.name)[0] ?? '' }
      })
  }
  return cache
}

export const DEFAULT_DB = join(import.meta.dirname, '..', 'suites', 'food-lookup', 'foods.jsonl')

export function searchFoods(query: string, db = DEFAULT_DB): Hit[] {
  const q = [...new Set(words(query))]
  if (q.length === 0) return []
  return index(db)
    .map((f) => {
      const hits = q.reduce((s, w) => s + (f.head.has(w) ? 2 : f.all.has(w) ? 1 : 0), 0)
      const extra = [...f.all].filter((w) => !q.includes(w)).length
      return { f, hits, score: hits + (q.includes(f.first) ? 1 : 0) - 0.1 * extra }
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.score - a.score || a.f.food.id - b.f.food.id)
    .slice(0, RESULTS)
    .map(({ f }) => ({
      fdc_id: f.food.id,
      name: f.food.name,
      kcal_per_100g: f.food.kcal_100g,
      portions: f.food.portions.slice(0, PORTIONS).map((p) => `${p.measure} = ${p.grams} g`),
    }))
}

if (import.meta.main) {
  for (const h of searchFoods(process.argv.slice(2).join(' '))) console.log(h.fdc_id, h.name, '|', h.portions.join('; '))
}
