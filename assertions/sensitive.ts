// promptfoo `javascript` assertion for the sensitive suite: does the model call
// the right categories, and so the right level? The reply is
// {"categories": {<id>: risk 0..1}, ...} (providers/ollama-sensitive.ts,
// providers/zero-shot.ts, providers/sensitive-composite.ts). A category is
// predicted when its risk is at least RISK_THRESHOLD; the case's expected
// categories are `vars.expected.categories`. Levels come only from levelOf
// (assertions/sensitive-levels.ts), for both sides.
//
// Score: a prediction below the expected level is a leak (weight LEAK_WEIGHT per
// level step), above it a false alarm (weight 1 per step). The error is the
// weighted steps divided by the worst the case allows in that direction (a
// public case can only be over-called, by 2 steps; a private one only
// under-called, by 2 steps = 6), and the score is 1 minus it, clamped to 0..1.
// An exact level scores 1. The case passes when the level is exact.
//
// Grading metadata, read by scripts/export-site.ts and the site: expected and
// predicted level, the outcome (exact | leak | false-alarm), per-category hits,
// misses and false alarms, and the case's category precision, recall and F1.
import { parseJson, type GradingResult } from './match.ts'
import { CATEGORIES, LEVELS, RISK_THRESHOLD, levelOf, rank, type Category, type Level } from './sensitive-levels.ts'

/** What a missed private image costs against a false alarm (owner decision Q4, 2026-11-04). */
export const LEAK_WEIGHT = 3

export interface SensitiveGrading {
  expected_level: Level
  predicted_level: Level
  outcome: 'exact' | 'leak' | 'false-alarm'
  expected: Category[]
  predicted: Category[]
  hits: Category[]
  misses: Category[]
  false_alarms: Category[]
  precision: number
  recall: number
  f1: number
  /** The model's risks as given, for the site's bars. */
  risks: Partial<Record<Category, number>>
  score: number
}

interface Reply {
  categories?: Record<string, unknown>
}

/** Grades one reply against the expected categories; null when the reply has no categories. */
export function compareSensitive(expected: readonly Category[], output: unknown, threshold = RISK_THRESHOLD): SensitiveGrading | null {
  const reply = parseJson(output) as Reply | undefined
  if (!reply?.categories || typeof reply.categories !== 'object') return null
  const risks: Partial<Record<Category, number>> = {}
  for (const c of CATEGORIES) {
    const r = Number(reply.categories[c])
    risks[c] = Number.isFinite(r) ? r : 0
  }
  const predicted = CATEGORIES.filter((c) => risks[c]! >= threshold)
  const hits = predicted.filter((c) => expected.includes(c))
  const misses = expected.filter((c) => !predicted.includes(c))
  const falseAlarms = predicted.filter((c) => !expected.includes(c))
  // With nothing to find (or nothing predicted) the ratio is vacuously perfect.
  const precision = predicted.length === 0 ? 1 : hits.length / predicted.length
  const recall = expected.length === 0 ? 1 : hits.length / expected.length
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
  const want = levelOf(expected)
  const got = levelOf(predicted)
  const step = rank(got) - rank(want)
  const outcome = step === 0 ? 'exact' : step < 0 ? 'leak' : 'false-alarm'
  const worst = step < 0 ? LEAK_WEIGHT * rank(want) : LEVELS.length - 1 - rank(want)
  const error = step === 0 ? 0 : (step < 0 ? LEAK_WEIGHT * -step : step) / worst
  return {
    expected_level: want,
    predicted_level: got,
    outcome,
    expected: [...expected],
    predicted,
    hits,
    misses,
    false_alarms: falseAlarms,
    precision,
    recall,
    f1,
    risks,
    score: Math.min(1, Math.max(0, 1 - error)),
  }
}

export default function (output: unknown, context: { vars: { expected: { categories: Category[] } } }): GradingResult & { metadata?: SensitiveGrading } {
  const g = compareSensitive(context.vars.expected.categories, output)
  if (!g) return { pass: false, score: 0, reason: 'reply has no categories' }
  const parts = [
    `level ${g.predicted_level} (wanted ${g.expected_level})${g.outcome === 'exact' ? '' : `: ${g.outcome}`}`,
    ...(g.hits.length ? [`hit ${g.hits.join(', ')}`] : []),
    ...(g.misses.length ? [`missed ${g.misses.join(', ')}`] : []),
    ...(g.false_alarms.length ? [`false alarm ${g.false_alarms.join(', ')}`] : []),
  ]
  return { pass: g.outcome === 'exact', score: g.score, reason: parts.join('; '), metadata: g }
}
