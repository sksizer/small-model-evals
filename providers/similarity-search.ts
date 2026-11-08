// promptfoo custom provider for the similarity suite, for the text+image embedders that
// providers/search.ts also loads (EmbeddingGemma 2, a nomic text+vision pair, Jina CLIP v2): ranks the
// pool by the cosine of their image vectors, no text prefix. The same reply and metadata as
// providers/image-embed.ts (assertions/similarity.ts reads it), kept in its own file so adding these
// models does not change the code the other similarity providers run.
//
// Config: a providers/search.ts config (`family`, `model`, `revision`, ...). Vars: `query` (a candidate
// id) and `pool` (`{id, file}` candidates; the query is in the pool and left out of the ranking).
// Output: {"query", "ranked": [[id, score], ...]}, every other candidate, best first.
// Metadata: embed_ms (mean per image embedded by this case), images, load_ms (first case), rss_mb.
import { loadEncoder, type Encoder, type SearchConfig } from './search.ts'

interface Candidate {
  id: string
  file: string
}

const encoders = new Map<string, Promise<Encoder>>()
const vectors = new Map<string, Promise<Float32Array>>()

const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i]!, 0)

export default class SimilaritySearch {
  private readonly config: SearchConfig

  constructor(options: { config: SearchConfig }) {
    this.config = options.config
  }

  id(): string {
    return `similarity-search:${this.config.model}@${this.config.revision?.slice(0, 7)}`
  }

  async callApi(_prompt: string, context: { vars: { query?: string; pool?: Candidate[] | string } }) {
    try {
      const { query } = context.vars
      // promptfoo hands a `file://` YAML var over as its JSON text.
      const pool = typeof context.vars.pool === 'string' ? (JSON.parse(context.vars.pool) as Candidate[]) : context.vars.pool
      if (!query || !Array.isArray(pool)) throw new Error('vars.query and vars.pool are required')
      const key = `${this.config.model}@${this.config.revision}:${this.config.dtype ?? ''}:${this.config.modalities ?? ''}`
      let loadMs: number | undefined
      if (!encoders.has(key)) {
        const t = performance.now()
        const p = loadEncoder(this.config)
        encoders.set(key, p)
        await p
        loadMs = performance.now() - t
      }
      const enc = await encoders.get(key)!
      const k = (c: Candidate) => `${key}\u0000${c.file}`
      const fresh = pool.filter((c) => !vectors.has(k(c)))
      const t = performance.now()
      // One at a time: concurrent inference would blur the per-image time and spike memory.
      for (const c of fresh) vectors.set(k(c), enc.docs([{ id: c.id, file: c.file }]).then((v) => v[0]!))
      const sigs = await Promise.all(pool.map(async (c) => [c.id, await vectors.get(k(c))!] as const))
      const embedMs = performance.now() - t
      const q = sigs.find(([id]) => id === query)?.[1]
      if (!q) throw new Error(`query ${query} is not in the pool`)
      const ranked = sigs
        .filter(([id]) => id !== query)
        .map(([id, s]) => [id, Math.round(dot(q, s) * 10000) / 10000] as const)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      return {
        output: JSON.stringify({ query, ranked }),
        metadata: {
          ...(fresh.length > 0 ? { embed_ms: embedMs / fresh.length } : {}),
          images: fresh.length,
          ...(loadMs === undefined ? {} : { load_ms: loadMs }),
          rss_mb: process.memoryUsage().rss / 2 ** 20,
        },
      }
    } catch (err) {
      return { error: String(err) }
    }
  }
}
