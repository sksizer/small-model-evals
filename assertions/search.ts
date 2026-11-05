// promptfoo `javascript` assertion for the search suite, and the ranking view the results site draws.
//
// The reply (providers/search.ts) is `{"query", "ranked": [[id, score], ...], "ranked_256"?}`: the
// top 20 candidates of the corpus, best first. `vars.relevant` lists the candidate ids that answer
// the query; every other candidate is irrelevant (binary relevance).
//
// Per query:
// - nDCG@10: DCG of the top ten (a relevant item at rank r counts 1 / log2(r + 1)) over the best
//   possible DCG with that many relevant items. The case's score.
// - recall@k (k = 1, 5, 10): relevant items in the top k, over min(k, how many are relevant), so a
//   query with one relevant item scores 1 at k = 1 when it ranks first, and a query with six cannot
//   be penalised for returning only five slots. (Plain recall at k = 1 would be at most 1/6 there.)
// - MRR: 1 / the rank of the first relevant item (0 when none is in the top 20).
// - nDCG@10 again on `ranked_256`, when the provider supplies it (EmbeddingGemma 2 truncated to 256
//   dimensions and re-normalised), recorded in the metadata as a bonus column.
//
// Pass mark: nDCG@10 >= 0.7. A query where the right item ranks first scores 1; where it ranks
// second, 0.63; third, 0.5. So 0.7 asks for the answer (or most of the answers) at rank 1, with at most
// one near miss, and anything weaker fails: a person looks at the top of a result list, and a good
// answer that sits third is a miss. It is the same bar as the other ranking suites.
import { parseJson, type GradingResult } from './match.ts'

const PASS_AT = 0.7
const CUT = 10

export type Ranked = [id: string, score: number][]

export interface SearchDetail {
  kind: string
  ndcg10: number
  r1: number
  r5: number
  r10: number
  mrr: number
  /** nDCG@10 of the 256-dimension ranking, when the provider made one. */
  ndcg10_256: number | null
  relevant: number
}

export interface SearchGrading extends GradingResult {
  metadata: SearchDetail | null
}

export function parseRanking(output: unknown, key = 'ranked'): Ranked | null {
  const got = parseJson(output) as Record<string, unknown> | undefined
  const ranked = got?.[key]
  if (!Array.isArray(ranked)) return null
  return ranked.every((r) => Array.isArray(r) && typeof r[0] === 'string' && typeof r[1] === 'number') ? (ranked as Ranked) : null
}

export function ndcg(ranked: Ranked, relevant: Set<string>, cut = CUT): number {
  if (relevant.size === 0) return 0
  const dcg = ranked.slice(0, cut).reduce((s, [id], i) => s + (relevant.has(id) ? 1 / Math.log2(i + 2) : 0), 0)
  let ideal = 0
  for (let i = 0; i < Math.min(cut, relevant.size); i++) ideal += 1 / Math.log2(i + 2)
  return dcg / ideal
}

const recall = (ranked: Ranked, relevant: Set<string>, k: number) => ranked.slice(0, k).filter(([id]) => relevant.has(id)).length / Math.min(k, relevant.size)

export function detailOf(kind: string, relevant: string[], output: unknown): SearchDetail | null {
  const ranked = parseRanking(output)
  if (!ranked) return null
  const rel = new Set(relevant)
  const first = ranked.findIndex(([id]) => rel.has(id))
  const r256 = parseRanking(output, 'ranked_256')
  return {
    kind,
    ndcg10: ndcg(ranked, rel),
    r1: recall(ranked, rel, 1),
    r5: recall(ranked, rel, 5),
    r10: recall(ranked, rel, 10),
    mrr: first < 0 ? 0 : 1 / (first + 1),
    ndcg10_256: r256 ? ndcg(r256, rel) : null,
    relevant: rel.size,
  }
}

export function gradeSearch(vars: { kind?: string; relevant: string[] }, output: unknown): SearchGrading {
  const d = detailOf(vars.kind ?? '', vars.relevant, output)
  if (!d) return { pass: false, score: 0, reason: 'reply has no ranking', metadata: null }
  const pct = (x: number) => `${Math.round(x * 100)}%`
  const reason = `nDCG@10 ${d.ndcg10.toFixed(2)}; recall @1 ${pct(d.r1)} @5 ${pct(d.r5)} @10 ${pct(d.r10)}; MRR ${d.mrr.toFixed(2)}${d.ndcg10_256 === null ? '' : `; 256-d nDCG@10 ${d.ndcg10_256.toFixed(2)}`}`
  return { pass: d.ndcg10 >= PASS_AT, score: d.ndcg10, reason, metadata: d }
}

/** One of the top candidates, for the site: whether it is a relevant one. */
export interface RankedView {
  id: string
  score: number
  relevant: boolean
}

/** The top candidates of a reply with their relevance, or null when the reply has no ranking. */
export function compareSearch(relevant: string[], output: unknown, top = 5): RankedView[] | null {
  const ranked = parseRanking(output)
  const rel = new Set(relevant)
  return ranked ? ranked.slice(0, top).map(([id, score]) => ({ id, score, relevant: rel.has(id) })) : null
}

export default function (output: unknown, context: { vars: { kind?: string; relevant: string[] } }): SearchGrading {
  return gradeSearch(context.vars, output)
}
