// promptfoo custom provider for the sensitive suite: zero-shot image-text
// scoring with SigLIP 2 or CLIP (ONNX, in-process with transformers.js). Each
// category (assertions/sensitive-levels.ts) has a few positive prompts; a few
// generic negative prompts ("an ordinary photo of a landscape") stand for
// "nothing sensitive". Text embeddings are computed once, then the text tower is
// released; each image needs only the vision tower. Weights are the same pinned
// revisions as the similarity suite's encoders (scripts/models.ts), plus the
// text tower of that revision.
//
// Risk per category, fixed rules (nothing tuned on the suite's cases):
// - `siglip`: sigmoid(logit_scale * cos + logit_bias) per prompt, as the model
//   card scores; the category's risk is its best positive prompt. A category is
//   present at risk >= 0.5, the sigmoid's own midpoint. logit_scale (exp'd) and
//   logit_bias are the checkpoint's, in config (`logit_scale`, `logit_bias`).
// - `clip`: softmax over the whole prompt set (positives and negatives) with the
//   model's logit scale of 100. The category's risk is p_best / (p_best +
//   p_negmax), its best positive prompt against the best negative one (the
//   softmax denominator cancels, so it is sigmoid(100 * (cos_best - cos_negmax))).
//   Risk >= 0.5 is exactly "the category beats every negative".
// `ordinary` is the mirror image: the best negative ("nothing sensitive") prompt scored the same
// way (siglip: its sigmoid; clip: the best negative against the best positive of any category).
// The composite uses it as positive evidence that a scene is ordinary (providers/sensitive-composite.ts).
// The threshold sweep (leaks against false alarms as the cut moves) is computed
// from these risks by scripts/export-site.ts, not here.
//
// Config: `kind` (siglip | clip), `model`, `revision`, `dtype`, and for siglip
// `logit_scale`, `logit_bias`. Vars: `image`.
// Output: {"categories": {id: risk}, "level"} (assertions/sensitive.ts).
// Metadata: classify_ms (encode one image and score it), load_ms (first case:
// both towers and the prompt embeddings), rss_mb.
import { AutoProcessor, AutoTokenizer, CLIPTextModelWithProjection, CLIPVisionModelWithProjection, SiglipTextModel, SiglipVisionModel, type RawImage } from '@huggingface/transformers'
import { CATEGORIES, levelFromRisks, type Category } from '../assertions/sensitive-levels.ts'
import { imageOf } from './region-detector.ts'

export interface ZeroShotConfig {
  kind: 'siglip' | 'clip'
  model: string
  revision: string
  dtype?: 'fp32' | 'fp16' | 'q8'
  /** SigLIP only: the checkpoint's exp(logit_scale) and logit_bias. */
  logit_scale?: number
  logit_bias?: number
}

/** Two to four positive prompts per category. */
export const POSITIVE: Record<Category, string[]> = {
  nudity: ['a photo of a naked person', 'a nude photograph', 'a photo of a person with bare breasts'],
  intimate: ['a photo of a person in underwear', 'a photo of a woman in lingerie', 'a photo of a man in underpants'],
  minor: ['a photo of a child', 'a photo of a young boy', 'a photo of a little girl'],
  face: ['a close-up portrait of a person', 'a headshot photo of a person looking at the camera', 'a selfie'],
  'id-document': ['a photo of a passport', 'a scan of an identity card', 'a photo of a driving licence'],
  financial: ['a photo of a credit card', 'a bank statement', 'an invoice with account numbers'],
  screen: ['a screenshot of a chat conversation', 'a screenshot of an email inbox', 'a phone screen showing messages'],
  medical: ['a medical prescription', 'a medical test result', 'an x-ray image'],
  location: ['a house with a visible house number', 'a car number plate', 'a street sign in front of a home'],
  credential: ['a sticky note with a password', 'a qr code', 'a boarding pass with a barcode'],
  document: ['a letter with personal details', 'a signed contract', 'a handwritten note'],
}

/** Generic prompts for "nothing sensitive here". */
export const NEGATIVE = [
  'an ordinary photo of a landscape',
  'a photo of food on a plate',
  'a photo of an animal',
  'a photo of a building',
  'a photo of an everyday object',
  'a photo of a street scene',
]

interface Loaded {
  processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>
  vision: (inputs: unknown) => Promise<Record<string, { data: Float32Array } | undefined>>
  /** Unit text embeddings, positives per category then negatives. */
  positive: Record<Category, Float32Array[]>
  negative: Float32Array[]
}

const loaded = new Map<string, Promise<Loaded>>()

function unit(v: Float32Array): Float32Array {
  const n = Math.hypot(...v)
  return v.map((x) => x / n)
}

async function load(c: ZeroShotConfig): Promise<Loaded> {
  const { model, revision, dtype = 'fp32', kind } = c
  const tokenizer = await AutoTokenizer.from_pretrained(model, { revision })
  const processor = await AutoProcessor.from_pretrained(model, { revision })
  const texts = [...CATEGORIES.flatMap((cat) => POSITIVE[cat]), ...NEGATIVE]
  // SigLIP's card: lowercase text padded to 64 tokens. CLIP pads to its longest prompt.
  const inputs = kind === 'siglip' ? tokenizer(texts.map((t) => t.toLowerCase()), { padding: 'max_length', max_length: 64, truncation: true }) : tokenizer(texts, { padding: true, truncation: true })
  const textNet = kind === 'siglip' ? await SiglipTextModel.from_pretrained(model, { revision, dtype }) : await CLIPTextModelWithProjection.from_pretrained(model, { revision, dtype })
  const out = (await textNet(inputs)) as Record<string, { data: Float32Array; dims: number[] } | undefined>
  const t = out[kind === 'siglip' ? 'pooler_output' : 'text_embeds']
  if (!t) throw new Error(`${model}: no text embedding in the output (${Object.keys(out).join(', ')})`)
  const width = t.dims[1]!
  const embedded = texts.map((_, i) => unit(t.data.slice(i * width, (i + 1) * width)))
  await textNet.dispose()
  let i = 0
  const positive = {} as Record<Category, Float32Array[]>
  for (const cat of CATEGORIES) positive[cat] = POSITIVE[cat].map(() => embedded[i++]!)
  const negative = NEGATIVE.map(() => embedded[i++]!)
  const net = kind === 'siglip' ? await SiglipVisionModel.from_pretrained(model, { revision, dtype }) : await CLIPVisionModelWithProjection.from_pretrained(model, { revision, dtype })
  return { processor, vision: net as unknown as Loaded['vision'], positive, negative }
}

const cosine = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i]!, 0)
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x))

/** The risk of every category for one image, and how long the load took when this call paid for it. */
export async function zeroShotRisks(c: ZeroShotConfig, image: RawImage): Promise<{ categories: Record<Category, number>; ordinary: number; loadMs?: number }> {
  const key = `${c.model}@${c.revision}:${c.dtype ?? 'fp32'}`
  let loadMs: number | undefined
  if (!loaded.has(key)) {
    const t = performance.now()
    const p = load(c)
    loaded.set(key, p)
    await p
    loadMs = performance.now() - t
  }
  const m = await loaded.get(key)!
  const out = await m.vision(await m.processor(image))
  const v = out[c.kind === 'siglip' ? 'pooler_output' : 'image_embeds']
  if (!v) throw new Error(`${c.model}: no image embedding in the output`)
  const img = unit(Float32Array.from(v.data))
  const categories = {} as Record<Category, number>
  const r3 = (n: number) => Math.round(n * 1000) / 1000
  const bestNegCos = Math.max(...m.negative.map((t) => cosine(img, t)))
  const bestPosCos = Math.max(...CATEGORIES.flatMap((cat) => m.positive[cat].map((t) => cosine(img, t))))
  let ordinary: number
  if (c.kind === 'siglip') {
    const { logit_scale, logit_bias } = c
    if (logit_scale === undefined || logit_bias === undefined) throw new Error('kind siglip needs logit_scale and logit_bias')
    for (const cat of CATEGORIES) categories[cat] = r3(Math.max(...m.positive[cat].map((t) => sigmoid(logit_scale * cosine(img, t) + logit_bias))))
    ordinary = r3(sigmoid(logit_scale * bestNegCos + logit_bias))
  } else {
    for (const cat of CATEGORIES) categories[cat] = r3(sigmoid(100 * (Math.max(...m.positive[cat].map((t) => cosine(img, t))) - bestNegCos)))
    ordinary = r3(sigmoid(100 * (bestNegCos - bestPosCos)))
  }
  return { categories, ordinary, ...(loadMs === undefined ? {} : { loadMs }) }
}

export default class ZeroShot {
  private readonly config: ZeroShotConfig

  constructor(options: { config: ZeroShotConfig }) {
    this.config = options.config
  }

  id(): string {
    return `zero-shot:${this.config.model}@${this.config.revision.slice(0, 7)}`
  }

  async callApi(_prompt: string, context: { vars: { image?: string } }) {
    try {
      const image = await imageOf(context.vars.image)
      const t = performance.now()
      const { categories, loadMs } = await zeroShotRisks(this.config, image)
      const total = performance.now() - t
      return {
        output: JSON.stringify({ categories, level: levelFromRisks(categories) }),
        metadata: {
          // The first case also paid for loading; its own time is the call minus that.
          classify_ms: total - (loadMs ?? 0),
          ...(loadMs === undefined ? {} : { load_ms: loadMs }),
          rss_mb: process.memoryUsage().rss / 2 ** 20,
        },
      }
    } catch (err) {
      return { error: String(err) }
    }
  }
}
