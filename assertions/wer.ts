// promptfoo `javascript` assertion for the transcribe suite, and the diff view the results site draws.
//
// The reply (providers/transcribe.ts) is the transcript as plain text; `vars.reference` is what was said.
// Both go through `normalise` and are then aligned word by word (Levenshtein), which counts
// substitutions (S), deletions (D) and insertions (I). WER = (S + D + I) / reference words, so it can
// pass 1 when the model writes more than was said.
//
// Score: max(0, 1 - WER). Pass at WER <= `vars.max_wer` (default 0.10: clean read speech; the plan sets
// 0.20 for the harder kinds, per case). The grading's `metadata` carries the counts and the alignment
// (`ops`), so the site can show reference and hypothesis with the differences marked.
//
// No package does this: `word-error-rate` (npm) only counts edits over text it is given, and nothing
// on npm ports Whisper's EnglishTextNormalizer. This is the same idea, kept modest: no spelling table
// for every British word, and numbers become digits only where the words form a plain cardinal.
import type { GradingResult } from './match.ts'

const DEFAULT_MAX_WER = 0.1

// ---- normaliser ---------------------------------------------------------------------------------

const ONES: Record<string, number> = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 }
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }
const SCALES: Record<string, number> = { thousand: 1e3, million: 1e6, billion: 1e9 }

/** Fillers that a transcript may or may not keep; Whisper's normaliser drops the same ones. */
const FILLERS = new Set(['hmm', 'mm', 'mhm', 'mmm', 'uh', 'um', 'uhm', 'er', 'erm'])

const TITLES: Record<string, string> = { mr: 'mister', mrs: 'missus', ms: 'miss', dr: 'doctor' }

/** British spellings that Whisper's table maps to American, the common ones only. */
const AMERICAN: Record<string, string> = {
  colour: 'color', colours: 'colors', favour: 'favor', favourite: 'favorite', honour: 'honor', humour: 'humor', labour: 'labor', neighbour: 'neighbor', neighbours: 'neighbors', behaviour: 'behavior', harbour: 'harbor', centre: 'center', centres: 'centers', theatre: 'theater', metre: 'meter', litre: 'liter', realise: 'realize', realised: 'realized', organise: 'organize', organised: 'organized', recognise: 'recognize', recognised: 'recognized', apologise: 'apologize', analyse: 'analyze', grey: 'gray', programme: 'program', defence: 'defense', offence: 'offense', travelled: 'traveled', travelling: 'traveling', cancelled: 'canceled', jewellery: 'jewelry', mould: 'mold', plough: 'plow', cosy: 'cozy', tyre: 'tire', aluminium: 'aluminum', whisky: 'whiskey',
}

/** Contraction endings, expanded so that "can't" and "can not" are one form. Applied to the text with apostrophes still in it. */
const CONTRACTIONS: [RegExp, string][] = [
  [/\bwon't\b/g, 'will not'],
  [/\bcan't\b/g, 'can not'],
  [/\bshan't\b/g, 'shall not'],
  [/\bain't\b/g, 'is not'],
  [/n't\b/g, ' not'],
  [/'re\b/g, ' are'],
  [/'ve\b/g, ' have'],
  [/'ll\b/g, ' will'],
  [/'m\b/g, ' am'],
  [/\bi'd\b/g, 'i would'],
  [/\b(you|he|she|we|they|it|that|who)'d\b/g, '$1 would'],
]

/** A run of number words ("one hundred and five", "twenty one") as one number; the rest of the words are returned as they were. */
function numbersFromWords(words: string[]): string[] {
  const out: string[] = []
  let i = 0
  while (i < words.length) {
    const w = words[i]!
    if (!(w in ONES) && !(w in TENS)) {
      out.push(w)
      i++
      continue
    }
    // total: finished thousands; current: the group in progress (under a thousand).
    let total = 0
    let current = 0
    let seen = false // a unit or tens word in the current group
    let used = 0
    for (let j = i; j < words.length; j++) {
      const x = words[j]!
      if (x in ONES && !(x === 'oh' && current === 0 && !seen && j === i)) {
        // "twenty one" adds a unit to tens; a unit after a unit ("one one") or after a teen starts a new number.
        if (seen && !(current % 10 === 0 && current >= 20)) break
        current += ONES[x]!
        seen = true
      } else if (x in TENS) {
        if (seen) break
        current += TENS[x]!
        seen = true
      } else if (x === 'hundred' && seen) {
        current *= 100
        seen = false
      } else if (x in SCALES && (seen || current > 0)) {
        total += current * SCALES[x]!
        current = 0
        seen = false
      } else if (x === 'and' && (current >= 100 || total > 0) && words[j + 1] !== undefined && (words[j + 1]! in ONES || words[j + 1]! in TENS)) {
        used++
        continue
      } else break
      used = j - i + 1
    }
    if (used === 0) {
      out.push(w)
      i++
      continue
    }
    // "oh" alone is the word, not zero.
    if (used === 1 && w === 'oh') out.push(w)
    else out.push(String(total + current))
    i += used
  }
  return out
}

/**
 * The form two transcripts of the same speech are compared in: lowercase; bracketed non-speech
 * ([laughter], (applause), <noise>) and fillers (um, uh) dropped; accents and punctuation dropped; contractions
 * expanded; common British spellings made American; titles spelled out; numbers as digits ("twenty one" and
 * "21" are both 21, "1,000" is 1000, "5%" is "5 percent"); apostrophes and hyphens gone ("well-known" is two words); one space between words.
 */
export function normalise(text: string): string {
  let s = text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[[(<{][^\])>}]*[\])>}]/g, ' ')
    .replace(/[’‘`´]/g, "'")
    .replace(/(\d),(?=\d{3}\b)/g, '$1') // 1,000 -> 1000
    .replace(/(\d)\s*%/g, '$1 percent')
    .replace(/\$\s*(\d[\d.]*)/g, '$1 dollars')
    .replace(/£\s*(\d[\d.]*)/g, '$1 pounds')
    .replace(/\b(mr|mrs|ms|dr)\./g, '$1 ')
  for (const [from, to] of CONTRACTIONS) s = s.replace(from, to)
  const words = s
    .replace(/'/g, '')
    .replace(/[-–—]/g, ' ')
    .replace(/(\d)\.(?!\d)/g, '$1 ') // "in 1984." keeps the number
    .replace(/[^\p{L}\p{N}.\s]/gu, ' ')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ')
    .split(/\s+/)
    .filter((w) => w !== '' && !FILLERS.has(w))
    .map((w) => TITLES[w] ?? AMERICAN[w] ?? w)
  return numbersFromWords(words).join(' ')
}

// ---- alignment ----------------------------------------------------------------------------------

/**
 * One step of the alignment: `=` a match (`ref` and `hyp` are the same word), `S` a substitution (`ref` was
 * heard as `hyp`), `D` a deletion (`ref` is missing), `I` an insertion (`hyp` was not said).
 */
export type Op = ['=' | 'S', ref: string, hyp: string] | ['D', ref: string, hyp: null] | ['I', ref: null, hyp: string]

export interface WerDetail {
  /** Reference words after normalising. */
  ref_words: number
  hyp_words: number
  sub: number
  del: number
  ins: number
  wer: number
  ops: Op[]
}

/** Word-level Levenshtein of `ref` into `hyp`, with the alignment; ties prefer a match, then a substitution, then a deletion. */
export function align(ref: string[], hyp: string[]): { ops: Op[]; sub: number; del: number; ins: number } {
  const n = ref.length
  const m = hyp.length
  // cost[i][j]: edits to turn ref[0..i) into hyp[0..j).
  const cost = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)))
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      cost[i]![j] = Math.min(cost[i - 1]![j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1), cost[i - 1]![j]! + 1, cost[i]![j - 1]! + 1)
    }
  }
  const ops: Op[] = []
  let i = n
  let j = m
  let sub = 0
  let del = 0
  let ins = 0
  while (i > 0 || j > 0) {
    const here = cost[i]![j]!
    if (i > 0 && j > 0 && ref[i - 1] === hyp[j - 1] && here === cost[i - 1]![j - 1]!) {
      ops.push(['=', ref[i - 1]!, hyp[j - 1]!])
      i--
      j--
    } else if (i > 0 && j > 0 && here === cost[i - 1]![j - 1]! + 1) {
      ops.push(['S', ref[i - 1]!, hyp[j - 1]!])
      sub++
      i--
      j--
    } else if (i > 0 && here === cost[i - 1]![j]! + 1) {
      ops.push(['D', ref[i - 1]!, null])
      del++
      i--
    } else {
      ops.push(['I', null, hyp[j - 1]!])
      ins++
      j--
    }
  }
  return { ops: ops.reverse(), sub, del, ins }
}

/** Normalises both texts and aligns them. An empty reference has no WER: it is 0 for an empty hypothesis and 1 otherwise. */
export function wer(reference: string, hypothesis: string): WerDetail {
  const ref = normalise(reference).split(' ').filter(Boolean)
  const hyp = normalise(hypothesis).split(' ').filter(Boolean)
  const { ops, sub, del, ins } = align(ref, hyp)
  const errors = sub + del + ins
  return { ref_words: ref.length, hyp_words: hyp.length, sub, del, ins, wer: ref.length === 0 ? (errors === 0 ? 0 : 1) : errors / ref.length, ops }
}

// ---- assertion ----------------------------------------------------------------------------------

export interface WerGrading extends GradingResult {
  metadata: WerDetail | null
}

export function gradeWer(vars: { reference: string; max_wer?: number }, output: unknown): WerGrading {
  if (typeof output !== 'string') return { pass: false, score: 0, reason: 'reply is not text', metadata: null }
  const max = vars.max_wer ?? DEFAULT_MAX_WER
  const d = wer(vars.reference, output)
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`
  return {
    pass: d.wer <= max,
    score: Math.max(0, 1 - d.wer),
    reason: `WER ${pct(d.wer)} (limit ${pct(max)}): ${d.sub} substituted, ${d.del} deleted, ${d.ins} inserted of ${d.ref_words} words`,
    metadata: d,
  }
}

export default function (output: unknown, context: { vars: { reference: string; max_wer?: number } }): WerGrading {
  return gradeWer(context.vars, output)
}
