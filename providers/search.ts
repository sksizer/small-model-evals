// promptfoo custom provider for the search suite: embeds a corpus once per run, then ranks it for
// each query by cosine similarity (a dot product: every vector is L2-normalised). Models run
// in-process (transformers.js, onnxruntime-node) or through Ollama's /api/embed.
//
// SearchConfig, by `family`:
// - `egemma2`: EmbeddingGemma 2 (onnx-community/embeddinggemma-2-ONNX), one model for text and
//   images in one 768-d space. `modalities`: `text` (vision and audio configs removed, the
//   270M text model only) or `text+image` (audio removed). The audio encoder is never loaded.
//   Queries are `task: search result | query: {q}`, text documents `title: {title|none} | text:
//   {content}`, images take no prefix (the model card). `mrl: 256` also ranks with the vectors
//   truncated to 256 dimensions and re-normalised (the card: re-normalise after truncating).
//   Run at q8: the card warns against float16 (activations overflow it).
// - `siglip` / `clip`: an image-text pair, text tower and vision tower (the same pinned revisions as the
//   similarity suite). SigLIP lowercases and pads to 64 tokens (its card); CLIP takes the text as is.
//   Text queries against images only; their text towers are not text retrievers.
// - `nomic-pair`: nomic-embed-text-v1.5 and nomic-embed-vision-v1.5 (one space, Apache-2.0),
//   run with onnxruntime-node because transformers.js has no `nomic_bert` class. Text:
//   mean-pooled, layer-normed, normalised, `search_query: ` / `search_document: ` prefixes; image:
//   the CLS token of the last hidden state, normalised (the cards' own recipes). fp32 files.
// - `jina-clip-v2`: jinaai/jina-clip-v2 (CC BY-NC 4.0), transformers.js' JinaCLIP, q8. Queries take the
//   card's retrieval prefix `Represent the query for retrieving evidence documents: `.
// - `ollama`: `model` (an Ollama tag), `query_prefix`, `doc_prefix`; text only.
// Every entry: `kinds` (which case kinds the model runs, read by scripts/run.ts), `model`, `revision`,
// `dtype` where it applies.
//
// Vars: `corpus` (a key of `corpora`), `query`, `corpora` (suites/search/corpora.yaml). A corpus item
// with a `file` is an image, else text (`title`, `text`). Each item is embedded once per run and kept,
// so only the first case of a corpus pays for it.
//
// Output: {"query", "ranked": [[id, score], ...], "ranked_256": [...]?}, the top 20, best first
// (assertions/search.ts). Metadata: item_ms (mean per item embedded by this case, absent when all
// were cached), items, query_ms, load_ms (first case only), rss_mb (in-process) or loaded_bytes
// (Ollama's reported size).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ort from 'onnxruntime-node'
import { AutoConfig, AutoModel, AutoProcessor, AutoTokenizer, CLIPTextModelWithProjection, CLIPVisionModelWithProjection, RawImage, SiglipTextModel, SiglipVisionModel } from '@huggingface/transformers'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OLLAMA = process.env['OLLAMA_HOST']?.startsWith('http') ? process.env['OLLAMA_HOST'] : 'http://localhost:11434'
const TOP = 20

export interface SearchConfig {
  family: 'egemma2' | 'siglip' | 'clip' | 'nomic-pair' | 'jina-clip-v2' | 'ollama'
  kinds?: string[]
  model: string
  revision?: string
  dtype?: string
  modalities?: 'text' | 'text+image'
  mrl?: number
  query_prefix?: string
  doc_prefix?: string
}

export interface Item {
  id: string
  file?: string
  title?: string
  text?: string
}

/** One loaded model: embeds queries and documents (text or image) to unit vectors. */
export interface Encoder {
  query(text: string): Promise<Float32Array>
  /** A batch of items of one kind (all images or all text). */
  docs(items: Item[]): Promise<Float32Array[]>
  /** What the model reports about its own size, for Ollama. */
  loadedBytes?(): Promise<number | null>
}

type Vec = Float32Array

const unit = (v: ArrayLike<number>): Vec => {
  const out = Float32Array.from(v)
  let n = 0
  for (const x of out) n += x * x
  n = Math.sqrt(n) || 1
  return out.map((x) => x / n)
}
const dot = (a: Vec, b: Vec) => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!
  return s
}
const rows = (t: { data: ArrayLike<number>; dims: number[] }): Vec[] => {
  const width = t.dims[t.dims.length - 1]!
  const n = t.data.length / width
  return Array.from({ length: n }, (_, i) => Float32Array.from(Array.prototype.slice.call(t.data, i * width, (i + 1) * width) as number[]))
}
const image = async (item: Item) => (await RawImage.read(join(ROOT, item.file!))).rgb()
const textDoc = (item: Item) => item.text ?? ''
const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n))

type Out = Record<string, { data: ArrayLike<number>; dims: number[] } | undefined>
const pick = (out: Out, key: string, who: string) => {
  const t = out[key]
  if (!t) throw new Error(`${who}: no ${key} in the output (${Object.keys(out).join(', ')})`)
  return t
}

// ---- EmbeddingGemma 2 ----------------------------------------------------------------------
async function egemma2(c: SearchConfig): Promise<Encoder> {
  const { model } = c
  const revision = c.revision!
  const config = await AutoConfig.from_pretrained(model, { revision })
  ;(config as unknown as Record<string, unknown>)['audio_config'] = null
  const withImages = c.modalities === 'text+image'
  if (!withImages) (config as unknown as Record<string, unknown>)['vision_config'] = null
  const processor = await AutoProcessor.from_pretrained(model, { revision })
  const net = await AutoModel.from_pretrained(model, { revision, config, dtype: (c.dtype ?? 'q8') as 'q8' })
  const embed = async (...inputs: unknown[]) => {
    const out = (await (net as unknown as (i: unknown) => Promise<Out>)(await (processor as unknown as (...a: unknown[]) => Promise<unknown>)(...inputs))) as Out
    return rows(pick(out, 'sentence_embedding', model)).map(unit)
  }
  return {
    query: async (q) => (await embed([`task: search result | query: ${q}`]))[0]!,
    docs: async (items) => {
      if (items[0]?.file) {
        if (!withImages) throw new Error(`${model}: loaded as text only`)
        const out: Vec[] = []
        for (const it of items) out.push((await embed(null, [[await image(it)]]))[0]!)
        return out
      }
      const out: Vec[] = []
      for (const batch of chunks(items, 16)) out.push(...(await embed(batch.map((it) => `title: ${it.title ?? 'none'} | text: ${textDoc(it)}`))))
      return out
    },
  }
}

// ---- SigLIP and CLIP -------------------------------------------------------------------------
async function pair(c: SearchConfig): Promise<Encoder> {
  const { model, family } = c
  const revision = c.revision!
  const dtype = (c.dtype ?? 'fp32') as 'fp32'
  const tokenizer = await AutoTokenizer.from_pretrained(model, { revision })
  const processor = await AutoProcessor.from_pretrained(model, { revision })
  const siglip = family === 'siglip'
  const text = siglip ? await SiglipTextModel.from_pretrained(model, { revision, dtype }) : await CLIPTextModelWithProjection.from_pretrained(model, { revision, dtype })
  const vision = siglip ? await SiglipVisionModel.from_pretrained(model, { revision, dtype }) : await CLIPVisionModelWithProjection.from_pretrained(model, { revision, dtype })
  return {
    query: async (q) => {
      const inputs = siglip ? tokenizer([q.toLowerCase()], { padding: 'max_length', max_length: 64, truncation: true }) : tokenizer([q], { padding: true, truncation: true })
      const out = (await (text as unknown as (i: unknown) => Promise<Out>)(inputs)) as Out
      return unit(rows(pick(out, siglip ? 'pooler_output' : 'text_embeds', model))[0]!)
    },
    docs: async (items) => {
      if (!items[0]?.file) throw new Error(`${model}: an image-text pair cannot index text`)
      const out: Vec[] = []
      for (const it of items) {
        const o = (await (vision as unknown as (i: unknown) => Promise<Out>)(await (processor as unknown as (i: unknown) => Promise<unknown>)(await image(it)))) as Out
        out.push(unit(rows(pick(o, siglip ? 'pooler_output' : 'image_embeds', model))[0]!))
      }
      return out
    },
  }
}

// ---- nomic: two bare ONNX files ------------------------------------------------------------
const CACHE = join(ROOT, '.cache', 'models')
async function weights(repo: string, revision: string, file: string): Promise<string> {
  const path = join(CACHE, repo, revision, file)
  if (!existsSync(path)) {
    const res = await fetch(`https://huggingface.co/${repo}/resolve/${revision}/${file}`)
    if (!res.ok) throw new Error(`${repo}/${file}: HTTP ${res.status}`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, new Uint8Array(await res.arrayBuffer()))
  }
  return path
}

async function nomicPair(c: SearchConfig & { vision_model: string; vision_revision: string }): Promise<Encoder> {
  const textFile = await weights(c.model, c.revision!, 'onnx/model.onnx')
  const visionFile = await weights(c.vision_model, c.vision_revision, 'onnx/model.onnx')
  const textNet = await ort.InferenceSession.create(textFile)
  const visionNet = await ort.InferenceSession.create(visionFile)
  const tokenizer = await AutoTokenizer.from_pretrained(c.model, { revision: c.revision! })
  const processor = await AutoProcessor.from_pretrained(c.vision_model, { revision: c.vision_revision })
  const embedText = async (texts: string[]): Promise<Vec[]> => {
    const enc = tokenizer(texts, { padding: true, truncation: true, max_length: 512 }) as unknown as Record<string, { data: BigInt64Array; dims: number[] }>
    const feeds: Record<string, ort.Tensor> = {}
    for (const name of textNet.inputNames) {
      const t = enc[name]
      if (t) feeds[name] = new ort.Tensor('int64', t.data, t.dims)
      else if (name === 'token_type_ids') feeds[name] = new ort.Tensor('int64', new BigInt64Array(enc['input_ids']!.data.length), enc['input_ids']!.dims)
      else throw new Error(`nomic text: no input ${name}`)
    }
    const out = await textNet.run(feeds)
    const hidden = out['last_hidden_state'] ?? out[textNet.outputNames[0]!]!
    const [n, len, width] = hidden.dims as [number, number, number]
    const mask = enc['attention_mask']!.data
    const data = hidden.data as Float32Array
    return Array.from({ length: n }, (_, i) => {
      // Mean over the real tokens, then layer norm without parameters (the card), then unit length.
      const v = new Float32Array(width)
      let count = 0
      for (let t = 0; t < len; t++) {
        if (mask[i * len + t] === 0n) continue
        count++
        for (let d = 0; d < width; d++) v[d]! += data[(i * len + t) * width + d]!
      }
      const mean = v.map((x) => x / Math.max(count, 1))
      const mu = mean.reduce((a, b) => a + b, 0) / width
      const variance = mean.reduce((a, b) => a + (b - mu) ** 2, 0) / width
      return unit(mean.map((x) => (x - mu) / Math.sqrt(variance + 1e-5)))
    })
  }
  return {
    query: async (q) => (await embedText([`search_query: ${q}`]))[0]!,
    docs: async (items) => {
      if (!items[0]?.file) {
        const out: Vec[] = []
        for (const batch of chunks(items, 16)) out.push(...(await embedText(batch.map((it) => `search_document: ${textDoc(it)}`))))
        return out
      }
      const out: Vec[] = []
      for (const it of items) {
        const px = (await (processor as unknown as (i: unknown) => Promise<{ pixel_values: { data: Float32Array; dims: number[] } }>)(await image(it))).pixel_values
        const res = await visionNet.run({ [visionNet.inputNames[0]!]: new ort.Tensor('float32', px.data, px.dims) })
        const hidden = res['last_hidden_state'] ?? res[visionNet.outputNames[0]!]!
        const width = hidden.dims[hidden.dims.length - 1]!
        out.push(unit((hidden.data as Float32Array).slice(0, width))) // token 0 is CLS
      }
      return out
    },
  }
}

// ---- jina-clip-v2 -----------------------------------------------------------------------------
async function jina(c: SearchConfig): Promise<Encoder> {
  const { model } = c
  const revision = c.revision!
  const processor = (await AutoProcessor.from_pretrained(model, { revision })) as unknown as (...a: unknown[]) => Promise<Record<string, unknown>>
  const net = (await AutoModel.from_pretrained(model, { revision, dtype: (c.dtype ?? 'q8') as 'q8' })) as unknown as (i: unknown) => Promise<Out>
  return {
    query: async (q) => unit(rows(pick(await net(await processor(`Represent the query for retrieving evidence documents: ${q}`, null, { padding: true, truncation: true })), 'l2norm_text_embeddings', model))[0]!),
    docs: async (items) => {
      const out: Vec[] = []
      if (items[0]?.file) for (const it of items) out.push(unit(rows(pick(await net(await processor(null, await image(it))), 'l2norm_image_embeddings', model))[0]!))
      else for (const it of items) out.push(unit(rows(pick(await net(await processor(textDoc(it), null, { padding: true, truncation: true })), 'l2norm_text_embeddings', model))[0]!))
      return out
    },
  }
}

// ---- Ollama ---------------------------------------------------------------------------------
async function ollama(c: SearchConfig): Promise<Encoder> {
  const embed = async (texts: string[]): Promise<Vec[]> => {
    const res = await fetch(`${OLLAMA}/api/embed`, { method: 'POST', body: JSON.stringify({ model: c.model, input: texts, keep_alive: '10m' }) })
    if (!res.ok) throw new Error(`${c.model}: HTTP ${res.status} ${await res.text()}`)
    return ((await res.json()) as { embeddings: number[][] }).embeddings.map(unit)
  }
  await embed(['warm up']) // load the model now, so load_ms is the load
  return {
    query: async (q) => (await embed([`${c.query_prefix ?? ''}${q}`]))[0]!,
    docs: async (items) => {
      if (items[0]?.file) throw new Error(`${c.model}: a text embedder cannot index images`)
      const out: Vec[] = []
      for (const batch of chunks(items, 32)) out.push(...(await embed(batch.map((it) => `${c.doc_prefix ?? ''}${textDoc(it)}`))))
      return out
    },
    loadedBytes: async () => {
      const ps = (await (await fetch(`${OLLAMA}/api/ps`)).json()) as { models: { name: string; model: string; size: number }[] }
      return ps.models.find((m) => m.name === c.model || m.model === c.model)?.size ?? null
    },
  }
}

export const loadEncoder = (c: SearchConfig): Promise<Encoder> => {
  switch (c.family) {
    case 'egemma2': return egemma2(c)
    case 'siglip':
    case 'clip': return pair(c)
    case 'nomic-pair': return nomicPair(c as SearchConfig & { vision_model: string; vision_revision: string })
    case 'jina-clip-v2': return jina(c)
    case 'ollama': return ollama(c)
  }
}

const encoders = new Map<string, Promise<Encoder>>()
const vectors = new Map<string, Promise<Vec>>()
const queryVectors = new Map<string, Promise<Vec>>()

export default class Search {
  private readonly config: SearchConfig

  constructor(options: { config: SearchConfig }) {
    this.config = options.config
  }

  id(): string {
    return `search:${this.config.model}@${this.config.revision?.slice(0, 7) ?? 'tag'}${this.config.modalities ? `:${this.config.modalities}` : ''}`
  }

  async callApi(_prompt: string, context: { vars: { corpus?: string; query?: string; corpora?: Record<string, Item[]> | string } }) {
    try {
      const c = this.config
      const { corpus, query } = context.vars
      const corpora = typeof context.vars.corpora === 'string' ? (JSON.parse(context.vars.corpora) as Record<string, Item[]>) : context.vars.corpora
      const items = corpus ? corpora?.[corpus] : undefined
      if (!query || !items) throw new Error('vars.query, vars.corpus and vars.corpora are required')
      const key = `${c.family}:${c.model}@${c.revision ?? ''}:${c.dtype ?? ''}:${c.modalities ?? ''}`
      let loadMs: number | undefined
      if (!encoders.has(key)) {
        const t = performance.now()
        const p = loadEncoder(c)
        encoders.set(key, p)
        await p
        loadMs = performance.now() - t
      }
      const enc = await encoders.get(key)!
      const vkey = (id: string) => `${key}\u0000${corpus}\u0000${id}`
      const fresh = items.filter((it) => !vectors.has(vkey(it.id)))
      const t0 = performance.now()
      if (fresh.length > 0) {
        // Images one at a time (concurrent inference would blur the per-item time and spike memory); text in batches.
        const batch = enc.docs(fresh)
        for (const [i, it] of fresh.entries()) {
          const v = batch.then((all) => all[i]!)
          v.catch(() => undefined) // reported once, by the await below
          vectors.set(vkey(it.id), v)
        }
        await batch
      }
      const embedMs = performance.now() - t0
      const t1 = performance.now()
      if (!queryVectors.has(`${key}\u0000${query}`)) queryVectors.set(`${key}\u0000${query}`, enc.query(query))
      const q = await queryVectors.get(`${key}\u0000${query}`)!
      const docs = await Promise.all(items.map(async (it) => [it.id, await vectors.get(vkey(it.id))!] as const))
      const rank = (a: Vec, score: (d: Vec) => number) =>
        docs.map(([id, d]) => [id, Math.round(score(d) * 10000) / 10000] as const).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, TOP)
      const ranked = rank(q, (d) => dot(q, d))
      const trunc = (v: Vec, n: number) => unit(v.slice(0, n))
      const ranked256 = c.mrl ? ((qn) => rank(qn, (d) => dot(qn, trunc(d, c.mrl!))))(trunc(q, c.mrl)) : null
      const queryMs = performance.now() - t1
      const loaded = enc.loadedBytes ? await enc.loadedBytes() : null
      return {
        output: JSON.stringify({ query, ranked, ...(ranked256 ? { ranked_256: ranked256 } : {}) }),
        metadata: {
          ...(fresh.length > 0 ? { item_ms: embedMs / fresh.length } : {}),
          items: fresh.length,
          query_ms: queryMs,
          ...(loadMs === undefined ? {} : { load_ms: loadMs }),
          ...(loaded === null ? { rss_mb: process.memoryUsage().rss / 2 ** 20 } : { loaded_bytes: loaded }),
        },
      }
    } catch (err) {
      return { error: String(err) }
    }
  }
}
