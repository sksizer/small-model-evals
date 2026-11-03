// promptfoo `javascript` assertion for the similarity suite, and the ranking
// view the results site draws.
//
// The reply (providers/image-embed.ts) is
// `{"query": id, "ranked": [[id, similarity], ...]}`: every candidate but the
// query, best first. `vars.expected` says how each candidate relates to the
// query, as lists of candidate ids; a candidate in no list is `other`:
//
//   expected:
//     copy:  [...]   # the query resized, recompressed, cropped, flipped, brightened
//     edit:  [...]   # the query with one thing changed (the edit suite's output)
//     scene: [...]   # another photo of the same place or object
//     class: [...]   # a different photo of the same kind of thing
//
// Per level that the case lists, recall@1 and recall@5 are measured with the
// stronger levels set aside (copy, then edit, then scene, then class), so each
// level answers its own question: once the exact copies are out of the way, does
// the model find the edit? Once the copies and edits are, the same scene? And
// they are capped at what is possible: the level's items in the top k of that
// list, divided by min(k, items), so a query with two copies scores 1 at k = 1
// when a copy ranks first. `other` is reported as other@5, the share of the
// raw top five that is unrelated (lower is better). `class` and `other` are
// reported, not scored: "the same kind of thing" is a search nicety, not a
// duplicate.
//
// Score: average precision of the ranking with the "same thing" levels (copy,
// edit, scene) as the relevant items, so a case scores 1 when every one of
// them ranks above every class or other candidate. The mean over cases is the
// suite's MAP. Passes at 0.7.
//
// Threshold check, recorded for the site: the single similarity cut-off that
// best separates (a) the copies, and (b) all same-thing items, from the rest of
// the pool, and how many candidates it gets wrong. A level counts as separable
// for a case with at most one mistake. (Whether one cut-off works across cases
// is for the reader of the per-case cut-offs; they are in the metadata.)
import { parseJson, type GradingResult } from './match.ts'

const PASS_AT = 0.7
const TOP = 5

export const LEVELS = ['copy', 'edit', 'scene', 'class'] as const
export type Level = (typeof LEVELS)[number] | 'other'
/** The levels that mean "the same thing": the ones that are scored. */
export const SAME_THING = ['copy', 'edit', 'scene'] as const

export interface ExpectedSimilarity {
  copy?: string[]
  edit?: string[]
  scene?: string[]
  class?: string[]
}

export type Ranked = [id: string, score: number][]

export interface LevelRecall {
  /** How many candidates the pool holds at this level. */
  n: number
  r1: number
  r5: number
}

export interface SimilarityDetail {
  levels: Partial<Record<(typeof LEVELS)[number], LevelRecall>>
  /** Share of the top five that is `other`. */
  other5: number
  /** Average precision over the same-thing items; the case's score. */
  ap: number
  /** Best single cut-off for copies against everything else, and the candidates it gets wrong. */
  copy_cut: { cut: number; mistakes: number } | null
  /** Likewise for copy + edit + scene against class + other. */
  same_cut: { cut: number; mistakes: number } | null
}

export interface SimilarityGrading extends GradingResult {
  metadata: SimilarityDetail | null
}

export function parseRanking(output: unknown): Ranked | null {
  const got = parseJson(output) as { ranked?: unknown } | undefined
  if (!got || !Array.isArray(got.ranked)) return null
  const ok = got.ranked.every((r) => Array.isArray(r) && typeof r[0] === 'string' && typeof r[1] === 'number')
  return ok ? (got.ranked as Ranked) : null
}

/** How a candidate relates to the query, from the case's lists. */
export function levelOf(expected: ExpectedSimilarity, id: string): Level {
  for (const level of LEVELS) if (expected[level]?.includes(id)) return level
  return 'other'
}

/** The cut-off that best splits `ranked` into the `positive` ids (score at or above it) and the rest, and its mistakes. */
function bestCut(ranked: Ranked, positive: Set<string>): { cut: number; mistakes: number } | null {
  if (positive.size === 0) return null
  const scores = [...new Set(ranked.map((r) => r[1]))].sort((a, b) => b - a)
  let best: { cut: number; mistakes: number } | null = null
  for (const cut of scores) {
    const mistakes = ranked.filter(([id, s]) => positive.has(id) !== s >= cut).length
    if (!best || mistakes < best.mistakes) best = { cut, mistakes }
  }
  return best
}

export function detailOf(expected: ExpectedSimilarity, ranked: Ranked): SimilarityDetail {
  const top = ranked.slice(0, TOP)
  const levels: SimilarityDetail['levels'] = {}
  for (const level of LEVELS) {
    const ids = new Set(expected[level] ?? [])
    if (ids.size === 0) continue
    // Candidates of a stronger level are set aside before measuring this one.
    const stronger = new Set(LEVELS.slice(0, LEVELS.indexOf(level)).flatMap((l) => expected[l] ?? []))
    const rest = ranked.filter(([id]) => !stronger.has(id))
    const inTop = (k: number) => rest.slice(0, k).filter(([id]) => ids.has(id)).length / Math.min(k, ids.size)
    levels[level] = { n: ids.size, r1: inTop(1), r5: inTop(TOP) }
  }
  const same = new Set(SAME_THING.flatMap((l) => expected[l] ?? []))
  let hits = 0
  let ap = 0
  ranked.forEach(([id], i) => {
    if (!same.has(id)) return
    hits++
    ap += hits / (i + 1)
  })
  return {
    levels,
    other5: top.filter(([id]) => levelOf(expected, id) === 'other').length / TOP,
    ap: same.size === 0 ? 0 : ap / same.size,
    copy_cut: bestCut(ranked, new Set(expected.copy ?? [])),
    same_cut: bestCut(ranked, same),
  }
}

export function gradeSimilarity(expected: ExpectedSimilarity, output: unknown): SimilarityGrading {
  const ranked = parseRanking(output)
  if (!ranked) return { pass: false, score: 0, reason: 'reply has no ranking', metadata: null }
  const d = detailOf(expected, ranked)
  const pct = (x: number) => `${Math.round(x * 100)}%`
  const notes = [
    `AP ${d.ap.toFixed(2)}`,
    ...Object.entries(d.levels).map(([level, r]) => `${level} @1 ${pct(r.r1)} @5 ${pct(r.r5)}`),
    `other in top 5: ${pct(d.other5)}`,
    ...(d.copy_cut ? [`copies ${d.copy_cut.mistakes <= 1 ? 'separable' : 'not separable'} (${d.copy_cut.mistakes} wrong at ${d.copy_cut.cut})`] : []),
  ]
  return { pass: d.ap >= PASS_AT, score: d.ap, reason: notes.join('; '), metadata: d }
}

/** One of the top candidates, for the site: its level and how alike the model rated it. */
export interface RankedView {
  id: string
  score: number
  level: Level
}

/** The top candidates of a reply with their levels, or null when the reply has no ranking. */
export function compareSimilarity(expected: ExpectedSimilarity, output: unknown, top = TOP): RankedView[] | null {
  const ranked = parseRanking(output)
  return ranked ? ranked.slice(0, top).map(([id, score]) => ({ id, score, level: levelOf(expected, id) })) : null
}

export default function (output: unknown, context: { vars: { expected: ExpectedSimilarity } }): SimilarityGrading {
  return gradeSimilarity(context.vars.expected, output)
}
