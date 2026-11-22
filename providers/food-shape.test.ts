import { describe, expect, test } from 'bun:test'
import { leads, normaliseUnit, parseMeasure, toGrams } from './food-shape.ts'

const milk = { portions: [{ measure: '1 cup', grams: 244 }, { measure: '1 fl oz', grams: 30.5 }] }
const egg = { portions: [{ measure: '1 large', grams: 50 }, { measure: '1 medium', grams: 44 }] }
const bread = { portions: [{ measure: '1 slice', grams: 28 }, { measure: '1 cup, cubes', grams: 30 }] }
const cola = { portions: [{ measure: '1 can (12 fl oz)', grams: 370 }, { measure: '1 fl oz', grams: 30.9 }] }
const flour = { portions: [{ measure: '1 cup', grams: 125 }] }
const peas = { portions: [{ measure: '1/2 cup', grams: 80 }] }

describe('parseMeasure', () => {
  test('whole, decimal and fraction counts', () => {
    expect(parseMeasure('1 cup, sliced')).toEqual({ count: 1, rest: 'cup, sliced' })
    expect(parseMeasure('0.25 cup')).toEqual({ count: 0.25, rest: 'cup' })
    expect(parseMeasure('1/2 cup')).toEqual({ count: 0.5, rest: 'cup' })
    expect(parseMeasure('1 1/2 cup')).toEqual({ count: 1.5, rest: 'cup' })
    expect(parseMeasure('cup')).toBeNull()
  })
})

describe('normaliseUnit', () => {
  test('plurals and spellings', () => {
    expect(normaliseUnit('Cups')).toBe('cup')
    expect(normaliseUnit('tbsps')).toBe('tbsp')
    expect(normaliseUnit('slices')).toBe('slice')
    expect(normaliseUnit('glasses')).toBe('glass')
    expect(normaliseUnit(null)).toBe('')
  })
})

describe('toGrams', () => {
  test('weights convert directly', () => {
    expect(toGrams(milk, 150, 'g')).toEqual({ grams: 150, basis: 'weight' })
    expect(toGrams(milk, 6, 'oz').grams).toBeCloseTo(170.1, 1)
    expect(toGrams(milk, 1, 'lb').grams).toBeCloseTo(453.6, 1)
  })
  test('a volume uses the food portion in that unit', () => {
    expect(toGrams(milk, 2, 'cups')).toEqual({ grams: 488, basis: 'volume-portion' })
    expect(toGrams(peas, 1, 'cup').grams).toBe(160)
  })
  test('a volume without its own portion goes through another volume portion', () => {
    expect(toGrams(flour, 2, 'tbsp').grams).toBeCloseTo((2 * 14.79 * 125) / 236.6, 3)
    expect(toGrams(milk, 250, 'ml').grams).toBeCloseTo((250 * 244) / 236.6, 3)
  })
  test('a volume with no volume portion is 1 g per ml', () => {
    expect(toGrams(egg, 100, 'ml')).toEqual({ grams: 100, basis: 'volume-ml' })
  })
  test('a count uses the portion that names it, else the usual portion', () => {
    expect(toGrams(bread, 2, 'slice')).toEqual({ grams: 56, basis: 'portion' })
    expect(toGrams(cola, 2, 'can')).toEqual({ grams: 740, basis: 'portion' })
    expect(toGrams(egg, 3, '')).toEqual({ grams: 132, basis: 'usual-portion' })
    expect(toGrams(egg, 2, 'egg')).toEqual({ grams: 88, basis: 'usual-portion' })
  })
  test('the usual portion is a count portion, medium first, never a cup of mashed', () => {
    const banana = { portions: [{ measure: '1 cup, mashed', grams: 225 }, { measure: '1 small', grams: 101 }, { measure: '1 medium (7" to 7-7/8" long)', grams: 118 }] }
    expect(toGrams(banana, 2, '')).toEqual({ grams: 236, basis: 'usual-portion' })
    expect(toGrams({ portions: [{ measure: '1 cup', grams: 244 }] }, 1, '')).toEqual({ grams: 244, basis: 'usual-portion' })
  })
  test('a unit with regex characters does not throw', () => {
    expect(toGrams(bread, 1, 'pc(s)').basis).toBe('usual-portion')
    expect(toGrams(bread, 1, '[slice').basis).toBe('usual-portion')
  })
  test('a unit that is an object property name is a count unit', () => {
    expect(toGrams(egg, 1, 'constructor').basis).toBe('usual-portion')
  })
  test('no quantity means one, and no portions fall back to 100 g', () => {
    expect(toGrams(bread, null, 'slice').grams).toBe(28)
    expect(toGrams({ portions: [] }, 2, '')).toEqual({ grams: 200, basis: 'default' })
  })
})

describe('leads', () => {
  test('the ratio is top over second, inclusive', () => {
    expect(leads([3, 2], 1.5)).toBe(true)
    expect(leads([3, 2.1], 1.5)).toBe(false)
    expect(leads([2.8, 2.7], 1.03)).toBe(true)
    expect(leads([3], 5)).toBe(true)
    expect(leads([], 1)).toBe(false)
  })
  test('ratio 1 always trusts the top match, a huge ratio never does', () => {
    expect(leads([2, 2], 1)).toBe(true)
    expect(leads([9, 1], 1000)).toBe(false)
  })
  test('a second score at or below zero is led by any higher top', () => {
    expect(leads([0.4, -0.2], 5)).toBe(true)
    expect(leads([0.4, 0], 5)).toBe(true)
  })
  test('the same ratio holds on a rescaled search', () => {
    expect(leads([30, 20], 1.5)).toBe(leads([3, 2], 1.5))
  })
})
