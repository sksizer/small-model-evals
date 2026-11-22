// The code half of the shaped food lookup (providers/ollama-food-shape.ts): turning a shaped item's quantity and
// unit into grams with a food's portions, and the rule that decides whether the top search match is trusted.
// Plain functions with no I/O, tested in providers/food-shape.test.ts.
import type { Food } from './food-search.ts'

export interface Portion {
  measure: string
  grams: number
}

export interface Amount {
  grams: number
  /** How the grams were reached, recorded in the result: a unit that is a weight or volume, a portion matched by name, the food's usual portion, or the 100 g fallback. */
  basis: 'weight' | 'volume-portion' | 'volume-ml' | 'portion' | 'usual-portion' | 'default'
}

const G_PER: Record<string, number> = { g: 1, gram: 1, kg: 1000, kilogram: 1000, oz: 28.35, ounce: 28.35, lb: 453.6, pound: 453.6 }
/** Millilitres per volume unit. */
const ML_PER: Record<string, number> = { ml: 1, millilitre: 1, milliliter: 1, l: 1000, litre: 1000, liter: 1000, cup: 236.6, tbsp: 14.79, tablespoon: 14.79, tsp: 4.93, teaspoon: 4.93, 'fl oz': 29.57, floz: 29.57 }
const UNIT_ALIAS: Record<string, string> = { grams: 'gram', ounces: 'ounce', pounds: 'pound', lbs: 'lb', cups: 'cup', tbsps: 'tbsp', tablespoons: 'tablespoon', tsps: 'tsp', teaspoons: 'teaspoon', litres: 'litre', liters: 'liter', millilitres: 'millilitre', milliliters: 'milliliter', mls: 'ml', 'fluid ounce': 'fl oz', 'fluid ounces': 'fl oz', 'fl. oz': 'fl oz' }

const FALLBACK_GRAMS = 100

/** Lower-cases a unit and folds plurals and spellings ("Cups" and "tbsps" to cup and tbsp). */
export function normaliseUnit(unit: string | null | undefined): string {
  const u = (unit ?? '').trim().toLowerCase().replace(/\.$/, '')
  return Object.hasOwn(UNIT_ALIAS, u) ? UNIT_ALIAS[u]! : stem(u)
}

function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1)
  return w
}

/** "1 cup, sliced" gives {count: 1, rest: "cup, sliced"}; "0.25 cup" and "1/2 cup" work; null when the measure starts with no number. */
export function parseMeasure(measure: string): { count: number; rest: string } | null {
  const mixed = /^\s*(\d+)\s+(\d+)\/(\d+)\s*(.*)$/.exec(measure)
  const frac = /^\s*(\d+)\/(\d+)\s*(.*)$/.exec(measure)
  const plain = /^\s*(\d+(?:\.\d+)?)\s*(.*)$/.exec(measure)
  const [count, rest] = mixed
    ? [Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]), mixed[4]!]
    : frac
      ? [Number(frac[1]) / Number(frac[2]), frac[3]!]
      : plain
        ? [Number(plain[1]), plain[2]!]
        : [0, '']
  return Number.isFinite(count) && count > 0 ? { count, rest: rest.toLowerCase() } : null
}

/** The portion's measure starts with this unit word ("cup" in "1 cup, sliced"; "fl oz" in "1 fl oz"). */
const leadsWith = (rest: string, unit: string) => rest.split(/[\s,(]+/).filter(Boolean).slice(0, unit.split(' ').length).join(' ').replace(/s$/, '') === unit

/** Grams per one unit of a portion list that names the unit (a cup, a slice), or null. */
function gramsPerUnit(portions: Portion[], unit: string, anywhere: boolean): number | null {
  for (const p of portions) {
    const parsed = parseMeasure(p.measure)
    if (!parsed) continue
    const has = anywhere ? new RegExp(`\\b${unit}s?\\b`).test(parsed.rest) : leadsWith(parsed.rest, unit)
    if (has) return p.grams / parsed.count
  }
  return null
}

const isMeasureUnit = (rest: string) => Object.keys({ ...G_PER, ...ML_PER }).some((u) => leadsWith(rest, u))

/**
 * What one usual portion of the food weighs: the first count portion that says "medium" (a banana, an apple), else
 * the first count portion ("1 slice", "1 large"), else the first portion of any kind; null when it has none. A
 * count portion is one not measured in weight or volume, so "1 cup, mashed" does not stand for a whole banana.
 */
function usualPortion(portions: Portion[]): number | null {
  const parsed = portions.map((p) => ({ p, m: parseMeasure(p.measure) }))
  const counted = parsed.filter(({ m }) => m !== null && !isMeasureUnit(m.rest))
  const pick = counted.find(({ m }) => m!.rest.includes('medium')) ?? counted[0] ?? parsed[0]
  if (!pick) return null
  return pick.m ? pick.p.grams / pick.m.count : pick.p.grams
}

/**
 * Grams for `quantity` of `unit` of a food. A weight unit converts directly. A volume unit uses the food's own
 * portion in that unit when it has one (a cup of milk is 244 g, a cup of flour 125 g), else other volume portions
 * through millilitres, else 1 g per ml. Any other unit is a count ("slice", "can", "egg", or none): the portion
 * whose measure names it, else the food's usual portion. No quantity means one.
 */
export function toGrams(food: Pick<Food, 'portions'>, quantity: number | null | undefined, unit: string | null | undefined): Amount {
  const q = typeof quantity === 'number' && Number.isFinite(quantity) && quantity > 0 ? quantity : 1
  const u = normaliseUnit(unit)
  const portions = food.portions
  const w = Object.hasOwn(G_PER, u) ? G_PER[u] : undefined
  if (w !== undefined) return { grams: q * w, basis: 'weight' }
  const ml = Object.hasOwn(ML_PER, u) ? ML_PER[u] : undefined
  if (ml !== undefined) {
    const own = gramsPerUnit(portions, u, false)
    if (own !== null) return { grams: q * own, basis: 'volume-portion' }
    for (const [other, perMl] of Object.entries(ML_PER)) {
      const g = other === u ? null : gramsPerUnit(portions, other, false)
      if (g !== null) return { grams: (q * ml * g) / perMl, basis: 'volume-portion' }
    }
    return { grams: q * ml, basis: 'volume-ml' }
  }
  if (u !== '' && u !== 'serving' && u !== 'piece' && u !== 'portion') {
    const named = gramsPerUnit(portions, u, true)
    if (named !== null) return { grams: q * named, basis: 'portion' }
  }
  const usual = usualPortion(portions)
  return usual === null ? { grams: q * FALLBACK_GRAMS, basis: 'default' } : { grams: q * usual, basis: 'usual-portion' }
}

/**
 * True when the top match's score is at least `ratio` times the second's; a lone match always leads. A ratio, not a
 * difference, so it does not depend on the scale a search scores on. A second score at or below zero (the ranking
 * subtracts for long names) is a lead whenever the top is above it.
 */
export function leads(scores: number[], ratio: number): boolean {
  if (scores.length === 0) return false
  if (scores.length === 1) return true
  const [top, second] = [scores[0]!, scores[1]!]
  return second <= 0 ? top > second : Math.round((top / second) * 1000) >= Math.round(ratio * 1000)
}
