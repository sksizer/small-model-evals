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
// - audio and video (docs/plans/av-search.md). A corpus item's `file` says what it is (providers/media.ts):
//   `.ogg` audio, `.mp4` video, else an image. ffmpeg decodes (clips are decoded here, not stored decoded).
//   - `egemma2` with `modalities: text+audio` also loads the 300M audio encoder and embeds a clip as
//     mono 16 kHz samples, no prefix (the card). With `text+image` it also embeds a video: frames at 1 fps
//     as a `RawVideo`, which the card's processor runs through the vision encoder (140 tokens a frame).
//   - `siglip` embeds a video as the mean of its 1 fps frame vectors, re-normalised.
//   - `clap`: Xenova/clap-htsat-unfused (transformers.js, q8): text <-> sound. CLAP takes 48 kHz audio of
//     10 s; a longer clip is cut to its middle 10 s (the extractor would crop at random, which no run
//     could repeat).
//   - `whisper`: speech -> transcript -> text. `model` is a Whisper checkpoint (transformers.js ASR
//     pipeline, 30 s windows with 5 s strides); `embedder` is the text embedder (a SearchConfig, here
//     EmbeddingGemma 2 text only) that embeds the transcript. The corpus item's `title` is for display and
//     never reaches the embedder. The reply carries each top result's transcript as `snippets`.
//   - `fingerprint`: no weights, our own (like pHash for images): 32 ms frames, 17 log-spaced bands, one
//     bit per band pair for whether the energy difference rose since the last frame (Haitsma and Kalker's
//     Philips fingerprint); two clips score 1 minus the bit error rate at the best alignment, so a
//     trimmed copy still matches. Clip queries only.
// Every entry: `kinds` (which case kinds the model runs, read by scripts/run.ts), `model`, `revision`,
// `dtype` where it applies.
//
// Vars: `corpus` (a key of `corpora`), `query` (text) or `query_item` (the id of a corpus clip: ranks the
// rest of the corpus by likeness to it), `corpora` (suites/search/corpora.yaml). A corpus item
// with a `file` is an image or clip, else text (`title`, `text`). Each item is embedded once per run and kept,
// so only the first case of a corpus pays for it.
//
// Output: {"query", "ranked": [[id, score], ...], "ranked_256": [...]?, "snippets": {id: text}?}, the top 20,
// best first (assertions/search.ts); a clip query is `query_item` and is not in the ranking. Metadata: item_ms (mean per item embedded by this case, absent when all
// were cached), items, query_ms, load_ms (first case only), rss_mb (in-process) or loaded_bytes
// (Ollama's reported size).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ort from 'onnxruntime-node'
import { AutoConfig, AutoModel, AutoProcessor, AutoTokenizer, CLIPTextModelWithProjection, CLIPVisionModelWithProjection, ClapAudioModelWithProjection, ClapTextModelWithProjection, RawImage, RawVideo, SiglipTextModel, SiglipVisionModel, pipeline } from '@huggingface/transformers'
import { frames, mediumOf, samples } from './media.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OLLAMA = process.env['OLLAMA_HOST']?.startsWith('http') ? process.env['OLLAMA_HOST'] : 'http://localhost:11434'
const TOP = 20

export interface SearchConfig {
  family: 'egemma2' | 'siglip' | 'clip' | 'nomic-pair' | 'jina-clip-v2' | 'ollama' | 'clap' | 'whisper' | 'fingerprint'
  kinds?: string[]
  model: string
  revision?: string
  dtype?: string
  modalities?: 'text' | 'text+image' | 'text+audio'
  /** `whisper`: the text embedder for the transcripts. */
  embedder?: SearchConfig
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
  /** How alike two document vectors are, when a dot product is not the measure (the fingerprint). */
  compare?(a: Vec, b: Vec): number
  /** A line to show beside a result, once the item is embedded (the transcript of a spoken clip). */
  note?(id: string): string | undefined
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
/** A clip's frames at 1 per second, as the pictures of a video (providers/media.ts). */
const videoFrames = async (item: Item) => Promise.all(frames(item.file!).map(async (f) => (await RawImage.read(f)).rgb()))
const video = async (item: Item) => {
  const fs = await videoFrames(item)
  return new RawVideo(fs, fs.length)
}
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
  const withImages = c.modalities === 'text+image'
  const withAudio = c.modalities === 'text+audio'
  if (!withAudio) (config as unknown as Record<string, unknown>)['audio_config'] = null
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
      const medium = mediumOf(items[0] ?? {})
      const out: Vec[] = []
      if (medium === 'image') {
        if (!withImages) throw new Error(`${model}: loaded without the vision encoder`)
        for (const it of items) out.push((await embed(null, [[await image(it)]]))[0]!)
      } else if (medium === 'video') {
        if (!withImages) throw new Error(`${model}: loaded without the vision encoder`)
        for (const it of items) out.push((await embed(null, null, null, await video(it)))[0]!)
      } else if (medium === 'audio') {
        if (!withAudio) throw new Error(`${model}: loaded without the audio encoder`)
        for (const it of items) out.push((await embed(null, null, samples(it.file!, 16000)))[0]!)
      } else {
        for (const batch of chunks(items, 16)) out.push(...(await embed(batch.map((it) => `title: ${it.title ?? 'none'} | text: ${textDoc(it)}`))))
      }
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
  const embedImage = async (img: RawImage) => {
    const o = (await (vision as unknown as (i: unknown) => Promise<Out>)(await (processor as unknown as (i: unknown) => Promise<unknown>)(img))) as Out
    return unit(rows(pick(o, siglip ? 'pooler_output' : 'image_embeds', model))[0]!)
  }
  return {
    query: async (q) => {
      const inputs = siglip ? tokenizer([q.toLowerCase()], { padding: 'max_length', max_length: 64, truncation: true }) : tokenizer([q], { padding: true, truncation: true })
      const out = (await (text as unknown as (i: unknown) => Promise<Out>)(inputs)) as Out
      return unit(rows(pick(out, siglip ? 'pooler_output' : 'text_embeds', model))[0]!)
    },
    docs: async (items) => {
      const medium = mediumOf(items[0] ?? {})
      if (medium === 'text' || medium === 'audio') throw new Error(`${model}: an image-text pair cannot index ${medium}`)
      const out: Vec[] = []
      for (const it of items) {
        // A video is its frames, one vector each, averaged and re-normalised.
        if (medium === 'video') {
          const vs: Vec[] = []
          for (const f of await videoFrames(it)) vs.push(await embedImage(f))
          out.push(unit(vs[0]!.map((_, d) => vs.reduce((a, v) => a + v[d]!, 0) / vs.length)))
        } else out.push(await embedImage(await image(it)))
      }
      return out
    },
  }
}

// ---- CLAP ---------------------------------------------------------------------------------------
const CLAP_RATE = 48000
const CLAP_SAMPLES = 10 * CLAP_RATE

async function clap(c: SearchConfig): Promise<Encoder> {
  const { model } = c
  const revision = c.revision!
  const dtype = (c.dtype ?? 'q8') as 'q8'
  const tokenizer = await AutoTokenizer.from_pretrained(model, { revision })
  const processor = await AutoProcessor.from_pretrained(model, { revision })
  const text = await ClapTextModelWithProjection.from_pretrained(model, { revision, dtype })
  const audio = await ClapAudioModelWithProjection.from_pretrained(model, { revision, dtype })
  return {
    query: async (q) => {
      const out = (await (text as unknown as (i: unknown) => Promise<Out>)(tokenizer([q], { padding: true, truncation: true }))) as Out
      return unit(rows(pick(out, 'text_embeds', model))[0]!)
    },
    docs: async (items) => {
      if (mediumOf(items[0] ?? {}) !== 'audio') throw new Error(`${model}: CLAP embeds sound clips and text only`)
      const out: Vec[] = []
      for (const it of items) {
        let wave = samples(it.file!, CLAP_RATE)
        if (wave.length > CLAP_SAMPLES) {
          const at = Math.floor((wave.length - CLAP_SAMPLES) / 2)
          wave = wave.subarray(at, at + CLAP_SAMPLES)
        }
        const o = (await (audio as unknown as (i: unknown) => Promise<Out>)(await (processor as unknown as (a: Float32Array) => Promise<unknown>)(wave))) as Out
        out.push(unit(rows(pick(o, 'audio_embeds', model))[0]!))
      }
      return out
    },
  }
}

// ---- Whisper, then a text embedder ---------------------------------------------------------------
type Transcribe = (audio: Float32Array, options: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>

async function whisper(c: SearchConfig): Promise<Encoder> {
  if (!c.embedder) throw new Error('whisper: config.embedder (the text embedder for the transcripts) is required')
  const asr = (await pipeline('automatic-speech-recognition', c.model, { revision: c.revision!, dtype: (c.dtype ?? 'q8') as 'q8' })) as unknown as Transcribe
  const embedder = await loadEncoder(c.embedder)
  const transcripts = new Map<string, string>()
  return {
    query: (q) => embedder.query(q),
    docs: async (items) => {
      const spoken: Item[] = []
      for (const it of items) {
        if (mediumOf(it) !== 'audio') throw new Error(`${c.model}: Whisper transcribes sound clips`)
        const r = await asr(samples(it.file!, 16000), { chunk_length_s: 30, stride_length_s: 5 })
        const words = (Array.isArray(r) ? r.map((x) => x.text).join(' ') : r.text).trim()
        transcripts.set(it.id, words)
        spoken.push({ id: it.id, text: words }) // no `title`: it is for the site and says what the clip is about
      }
      return embedder.docs(spoken)
    },
    note: (id) => transcripts.get(id),
  }
}

// ---- audio fingerprint ----------------------------------------------------------------------------
const FP_RATE = 16000
const FP_WINDOW = 1024
const FP_HOP = 512
const FP_BANDS = 17
const FP_LOW_HZ = 300
const FP_HIGH_HZ = 6000
const POPCOUNT = Uint8Array.from({ length: 1 << 16 }, (_, n) => {
  let bits = 0
  for (let x = n; x > 0; x >>= 1) bits += x & 1
  return bits
})

/** In-place radix-2 FFT of `re` + i `im`; the length is a power of two. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j]!, re[i]!]
      ;[im[i], im[j]] = [im[j]!, im[i]!]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(angle * k)
        const wi = Math.sin(angle * k)
        const a = i + k
        const b = a + len / 2
        const tr = re[b]! * wr - im[b]! * wi
        const ti = re[b]! * wi + im[b]! * wr
        re[b] = re[a]! - tr
        im[b] = im[a]! - ti
        re[a] = re[a]! + tr
        im[a] = im[a]! + ti
      }
    }
  }
}

/** One 16-bit word per frame (after the first): bit b is whether the energy step from band b to b+1 grew since the previous frame. */
export function fingerprint(wave: Float32Array): Float32Array {
  const hann = Float64Array.from({ length: FP_WINDOW }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FP_WINDOW))
  const edges = Array.from({ length: FP_BANDS + 1 }, (_, i) => Math.round((FP_LOW_HZ * (FP_HIGH_HZ / FP_LOW_HZ) ** (i / FP_BANDS) * FP_WINDOW) / FP_RATE))
  const re = new Float64Array(FP_WINDOW)
  const im = new Float64Array(FP_WINDOW)
  const words: number[] = []
  let previous: number[] | null = null
  for (let start = 0; start + FP_WINDOW <= wave.length; start += FP_HOP) {
    for (let i = 0; i < FP_WINDOW; i++) {
      re[i] = wave[start + i]! * hann[i]!
      im[i] = 0
    }
    fft(re, im)
    // Log energy per band: a change of volume shifts every band alike, which the differences cancel.
    const energy = Array.from({ length: FP_BANDS }, (_, b) => {
      let e = 0
      for (let k = edges[b]!; k < Math.max(edges[b + 1]!, edges[b]! + 1); k++) e += re[k]! ** 2 + im[k]! ** 2
      return Math.log(e + 1e-9)
    })
    if (previous) {
      let word = 0
      for (let b = 0; b < FP_BANDS - 1; b++) {
        const step = energy[b]! - energy[b + 1]!
        const before = previous[b]! - previous[b + 1]!
        if (step - before > 0) word |= 1 << b
      }
      words.push(word)
    }
    previous = energy
  }
  return Float32Array.from(words)
}

/** One minus the bit error rate at the best alignment of the shorter clip inside the longer, over at least half of the shorter. */
export function fingerprintMatch(a: Float32Array, b: Float32Array): number {
  const [s, l] = a.length <= b.length ? [a, b] : [b, a]
  const least = Math.ceil(s.length / 2)
  let best = 0
  for (let offset = least - s.length; offset <= l.length - least; offset++) {
    const from = Math.max(0, -offset)
    const to = Math.min(s.length, l.length - offset)
    if (to - from < least) continue
    let wrong = 0
    for (let i = from; i < to; i++) wrong += POPCOUNT[s[i]! ^ l[i + offset]!]!
    best = Math.max(best, 1 - wrong / ((FP_BANDS - 1) * (to - from)))
  }
  return best
}

function fingerprinter(c: SearchConfig): Encoder {
  return {
    query: async () => {
      throw new Error(`${c.model}: a fingerprint ranks clips by clips, it has no text query`)
    },
    docs: async (items) =>
      items.map((it) => {
        if (mediumOf(it) !== 'audio') throw new Error(`${c.model}: the fingerprint is for sound clips`)
        return fingerprint(samples(it.file!, FP_RATE))
      }),
    compare: fingerprintMatch,
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
    case 'clap': return clap(c)
    case 'whisper': return whisper(c)
    case 'fingerprint': return Promise.resolve(fingerprinter(c))
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

  async callApi(_prompt: string, context: { vars: { corpus?: string; query?: string; query_item?: string; corpora?: Record<string, Item[]> | string } }) {
    try {
      const c = this.config
      const { corpus, query, query_item: queryItem } = context.vars
      const corpora = typeof context.vars.corpora === 'string' ? (JSON.parse(context.vars.corpora) as Record<string, Item[]>) : context.vars.corpora
      const items = corpus ? corpora?.[corpus] : undefined
      if ((!query && !queryItem) || !items) throw new Error('vars.query (or vars.query_item), vars.corpus and vars.corpora are required')
      if (queryItem && !items.some((it) => it.id === queryItem)) throw new Error(`query_item ${queryItem} is not in the ${corpus} corpus`)
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
      // A clip query is another corpus item: its own vector, and it stays out of the ranking.
      if (!queryItem && !queryVectors.has(`${key}\u0000${query}`)) queryVectors.set(`${key}\u0000${query}`, enc.query(query!))
      const q = queryItem ? await vectors.get(vkey(queryItem))! : await queryVectors.get(`${key}\u0000${query}`)!
      const docs = await Promise.all(items.filter((it) => it.id !== queryItem).map(async (it) => [it.id, await vectors.get(vkey(it.id))!] as const))
      const similar = enc.compare ?? dot
      const rank = (score: (d: Vec) => number) =>
        docs.map(([id, d]) => [id, Math.round(score(d) * 10000) / 10000] as const).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, TOP)
      const ranked = rank((d) => similar(q, d))
      const trunc = (v: Vec, n: number) => unit(v.slice(0, n))
      const ranked256 = c.mrl ? ((qn) => rank((d) => dot(qn, trunc(d, c.mrl!))))(trunc(q, c.mrl)) : null
      const snippets = Object.fromEntries(ranked.slice(0, 5).flatMap(([id]) => (enc.note?.(id) ? [[id, enc.note(id)!.slice(0, 240)] as const] : [])))
      const queryMs = performance.now() - t1
      const loaded = enc.loadedBytes ? await enc.loadedBytes() : null
      return {
        output: JSON.stringify({ query: query ?? queryItem, ranked, ...(ranked256 ? { ranked_256: ranked256 } : {}), ...(Object.keys(snippets).length > 0 ? { snippets } : {}) }),
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
