// promptfoo custom provider for image similarity: ranks a pool of candidate
// images by how alike each is to a query image. Used by the similarity suite.
// Runs in-process (no Ollama): perceptual hashes with sharp, embedding models
// as ONNX through transformers.js.
//
// Config, by `kind`:
// - `phash`: 64-bit DCT hash. Grayscale, 32x32, 2-D DCT, the lowest 8x8
//   frequencies, each bit set when its coefficient is above the median of
//   the 64 (the imagehash recipe). Similarity is 1 - Hamming distance / 64.
// - `dhash`: 64-bit gradient hash. Grayscale, 9x8, each bit set when a pixel
//   is darker than its right neighbour. Same similarity.
// - `embed`: an image encoder. `model` (Hugging Face id), `revision` (commit,
//   pinned so the weights never change under a snapshot), `dtype`, and
//   `tower` for how to load it: `clip` (CLIPVisionModelWithProjection; the
//   projected `image_embeds`), `siglip` (SiglipVisionModel; its pooled
//   `pooler_output`) or `dino` (AutoModel; `pooler_output` when the export
//   has one, else the CLS token of `last_hidden_state`, which is what the
//   DINO model cards use). CLIP and SigLIP load their vision tower only, so
//   the text tower's weights are never read. The model's own preprocessor
//   (resize, centre crop, normalisation) runs unchanged. The vector is
//   L2-normalised; similarity is the cosine, a dot product.
//
// Vars: `query` (a candidate id) and `pool` (the candidates: `{id, file}`,
// `file` a path from the repo root). The query is itself in the pool and is
// left out of the ranking. Each image is hashed or embedded once per run and
// the result kept, so only the first case pays for the pool.
//
// Output: {"query": id, "ranked": [[id, score], ...]}, every other candidate,
// best first, scores to 4 places (assertions/similarity.ts). Metadata:
// embed_ms (mean per image embedded by this case; absent when all were cached),
// images (how many that was), load_ms (first case only), rss_mb (process
// memory afterwards, an upper bound on the model's footprint).
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { AutoModel, AutoProcessor, CLIPVisionModelWithProjection, RawImage, SiglipVisionModel } from '@huggingface/transformers'

// Providers run inside promptfoo's Node, so no Bun-only import.meta.dir here.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

interface Config {
  kind: 'phash' | 'dhash' | 'embed'
  model?: string
  revision?: string
  dtype?: 'fp32' | 'fp16' | 'q8' | 'int8' | 'uint8' | 'q4' | 'bnb4' | 'q4f16'
  tower?: 'clip' | 'siglip' | 'dino'
}

interface Candidate {
  id: string
  file: string
}

/** A vector, or for the hashes a list of bits, comparable with `similarity`. */
type Signature = Float32Array | Uint8Array

const HASH_BITS = 64

async function grey(file: string, width: number, height: number): Promise<Float64Array> {
  const { data } = await sharp(join(ROOT, file)).flatten({ background: '#ffffff' }).greyscale().resize(width, height, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true })
  return Float64Array.from(data)
}

/** DCT-II basis for the 8 lowest frequencies over 32 samples (the scale does not matter for the median test). */
const DCT_N = 32
const DCT_COS = Array.from({ length: 8 }, (_, k) => Array.from({ length: DCT_N }, (_, n) => Math.cos(((2 * n + 1) * k * Math.PI) / (2 * DCT_N))))

async function phash(file: string): Promise<Uint8Array> {
  const px = await grey(file, DCT_N, DCT_N)
  // Only the lowest 8 frequencies each way are kept: rows first, then columns.
  const rows = Array.from({ length: DCT_N }, (_, y) => Array.from({ length: 8 }, (_, k) => DCT_COS[k]!.reduce((s, c, x) => s + c * px[y * DCT_N + x]!, 0)))
  const coef: number[] = []
  for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) coef.push(DCT_COS[v]!.reduce((s, c, y) => s + c * rows[y]![u]!, 0))
  const sorted = [...coef].sort((a, b) => a - b)
  const median = (sorted[HASH_BITS / 2 - 1]! + sorted[HASH_BITS / 2]!) / 2
  return Uint8Array.from(coef, (c) => (c > median ? 1 : 0))
}

async function dhash(file: string): Promise<Uint8Array> {
  const px = await grey(file, 9, 8)
  const bits: number[] = []
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits.push(px[y * 9 + x]! < px[y * 9 + x + 1]! ? 1 : 0)
  return Uint8Array.from(bits)
}

function similarity(a: Signature, b: Signature): number {
  if (a instanceof Uint8Array) {
    let differ = 0
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differ++
    return 1 - differ / a.length
  }
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i]! * (b as Float32Array)[i]!
  return dot
}

type Encoder = (file: string) => Promise<Float32Array>

const encoders = new Map<string, Promise<Encoder>>()
const signatures = new Map<string, Promise<Signature>>()

async function loadEncoder(c: Config): Promise<Encoder> {
  const { model, revision, dtype = 'fp32', tower } = c
  if (!model || !revision || !tower) throw new Error('kind embed needs model, revision and tower')
  const processor = await AutoProcessor.from_pretrained(model, { revision })
  const loader = tower === 'clip' ? CLIPVisionModelWithProjection : tower === 'siglip' ? SiglipVisionModel : AutoModel
  const net = await loader.from_pretrained(model, { revision, dtype })
  return async (file) => {
    const out = (await net(await processor(await RawImage.read(join(ROOT, file))))) as Record<string, { dims: number[]; data: Float32Array } | undefined>
    const pooled = out['image_embeds'] ?? out['pooler_output']
    const last = out['last_hidden_state']
    // [1, tokens, width]: token 0 is CLS for the DINO family.
    const vec = pooled ? pooled.data : last ? last.data.slice(0, last.dims[2]) : null
    if (!vec) throw new Error(`${model}: no image_embeds, pooler_output or last_hidden_state in the output`)
    const v = Float32Array.from(vec)
    const norm = Math.hypot(...v)
    return v.map((x) => x / norm)
  }
}

export default class ImageEmbed {
  private readonly config: Config

  constructor(options: { config: Config }) {
    this.config = options.config
  }

  id(): string {
    const { kind, model, revision } = this.config
    return kind === 'embed' ? `image-embed:${model}@${revision?.slice(0, 7)}` : `image-embed:${kind}`
  }

  async callApi(_prompt: string, context: { vars: { query?: string; pool?: Candidate[] | string } }) {
    try {
      const { query } = context.vars
      // promptfoo hands a `file://` YAML var over as its JSON text.
      const pool = typeof context.vars.pool === 'string' ? (JSON.parse(context.vars.pool) as Candidate[]) : context.vars.pool
      if (!query || !Array.isArray(pool)) throw new Error('vars.query and vars.pool are required')
      const { kind } = this.config
      const key = kind === 'embed' ? `${this.config.model}@${this.config.revision}:${this.config.dtype ?? 'fp32'}` : kind
      let loadMs: number | undefined
      if (kind === 'embed' && !encoders.has(key)) {
        const t = performance.now()
        const p = loadEncoder(this.config)
        encoders.set(key, p)
        await p
        loadMs = performance.now() - t
      }
      const sign = async (c: Candidate): Promise<Signature> => {
        const k = `${key}\u0000${c.file}`
        if (!signatures.has(k)) {
          signatures.set(k, kind === 'phash' ? phash(c.file) : kind === 'dhash' ? dhash(c.file) : encoders.get(key)!.then((encode) => encode(c.file)))
        }
        return signatures.get(k)!
      }
      const fresh = pool.filter((c) => !signatures.has(`${key}\u0000${c.file}`)).length
      const t = performance.now()
      // One at a time: concurrent inference would blur the per-image time and spike memory.
      const sigs: (readonly [string, Signature])[] = []
      for (const c of pool) sigs.push([c.id, await sign(c)] as const)
      const embedMs = performance.now() - t
      const q = sigs.find(([id]) => id === query)?.[1]
      if (!q) throw new Error(`query ${query} is not in the pool`)
      const ranked = sigs
        .filter(([id]) => id !== query)
        .map(([id, s]) => [id, Math.round(similarity(q, s) * 10000) / 10000] as const)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      return {
        output: JSON.stringify({ query, ranked }),
        metadata: {
          ...(fresh > 0 ? { embed_ms: embedMs / fresh } : {}),
          images: fresh,
          ...(loadMs === undefined ? {} : { load_ms: loadMs }),
          rss_mb: process.memoryUsage().rss / 2 ** 20,
        },
      }
    } catch (err) {
      return { error: String(err) }
    }
  }
}
