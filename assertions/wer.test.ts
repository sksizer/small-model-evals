import { describe, expect, test } from 'bun:test'
import { align, gradeWer, normalise, wer } from './wer.ts'

describe('normalise', () => {
  test('lowercases and drops punctuation', () => {
    expect(normalise('Hello, World!  It\'s "fine".')).toBe('hello world its fine')
  })
  test('drops bracketed non-speech and fillers', () => {
    expect(normalise('Well [laughter] um, (applause) that is <noise> good, uh.')).toBe('well that is good')
  })
  test('expands contractions so both forms agree', () => {
    expect(normalise("I can't, won't, and they've")).toBe(normalise('I can not, will not, and they have'))
    expect(normalise("She'd gone and I'd stayed")).toBe('she would gone and i would stayed')
  })
  test('spells numbers as digits, from words or digits', () => {
    expect(normalise('twenty one')).toBe('21')
    expect(normalise('one hundred and five')).toBe('105')
    expect(normalise('two thousand and twenty')).toBe('2020')
    expect(normalise('1,000 people')).toBe('1000 people')
    expect(normalise('five percent')).toBe(normalise('5%'))
    expect(normalise('three five')).toBe('3 5')
  })
  test('keeps the word oh and a decimal point', () => {
    expect(normalise('oh no')).toBe('oh no')
    expect(normalise('pi is 3.14.')).toBe('pi is 3.14')
  })
  test('unifies titles, accents, hyphens and British spellings', () => {
    expect(normalise('Mr. Smith, café, well-known colour')).toBe('mister smith cafe well known color')
  })
  test('empty and symbol-only text normalise to empty', () => {
    expect(normalise('')).toBe('')
    expect(normalise(' ... [music] ')).toBe('')
  })
})

describe('align', () => {
  test('counts substitutions, deletions and insertions', () => {
    expect(align(['a', 'b', 'c'], ['a', 'x', 'c']).ops).toEqual([['=', 'a', 'a'], ['S', 'b', 'x'], ['=', 'c', 'c']])
    expect(align(['a', 'b', 'c'], ['a', 'c']).ops).toEqual([['=', 'a', 'a'], ['D', 'b', null], ['=', 'c', 'c']])
    expect(align(['a', 'c'], ['a', 'b', 'c']).ops).toEqual([['=', 'a', 'a'], ['I', null, 'b'], ['=', 'c', 'c']])
  })
})

describe('wer', () => {
  test('identical text is 0 after normalising', () => {
    expect(wer('The cat sat.', 'the cat SAT').wer).toBe(0)
  })
  test('one wrong word in four is 0.25', () => {
    const d = wer('the cat sat down', 'the cat sit down')
    expect(d).toMatchObject({ sub: 1, del: 0, ins: 0, ref_words: 4, wer: 0.25 })
  })
  test('empty hypothesis deletes every word: WER 1', () => {
    expect(wer('the cat sat', '')).toMatchObject({ del: 3, wer: 1 })
  })
  test('empty reference: 0 for an empty hypothesis, else 1 however long', () => {
    expect(wer('', '').wer).toBe(0)
    expect(wer('', 'something said').wer).toBe(1)
  })
  test('insertions can push WER above 1', () => {
    expect(wer('hi', 'oh hi there you').wer).toBe(3)
  })
})

describe('gradeWer', () => {
  test('passes within the default limit and scores 1 - WER', () => {
    const g = gradeWer({ reference: 'one two three four five six seven eight nine ten' }, 'one two three four five six seven eight nine tin')
    expect(g.pass).toBe(true)
    expect(g.score).toBeCloseTo(0.9)
  })
  test('uses vars.max_wer', () => {
    const vars = { reference: 'a b c d e', max_wer: 0.1 }
    expect(gradeWer(vars, 'a b c d x').pass).toBe(false)
    expect(gradeWer({ ...vars, max_wer: 0.2 }, 'a b c d x').pass).toBe(true)
  })
  test('score floors at 0 and the reason shows the counts', () => {
    const g = gradeWer({ reference: 'hi' }, 'oh hi there you')
    expect(g.score).toBe(0)
    expect(g.reason).toContain('3 inserted of 1 words')
    expect(g.metadata?.ops).toHaveLength(4)
  })
  test('a reply that is not text fails', () => {
    expect(gradeWer({ reference: 'hi' }, undefined).pass).toBe(false)
  })
})
