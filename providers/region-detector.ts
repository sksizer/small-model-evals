// promptfoo custom provider for small object detectors (ONNX, run in-process
// with transformers.js; no Ollama). Used by the regions suite.
//
// Two kinds, by `task`:
// - `object-detection`: a fixed-class detector (DETR, RT-DETR, ...); it
//   finds every class it knows, and the scorer keeps the labels a case asks
//   about.
// - `zero-shot-object-detection`: an open-vocabulary detector (OWL-ViT,
//   OWLv2, Grounding DINO); it looks for the case's `find` phrases.
//
// Config: `model` (Hugging Face id), `revision` (commit, pinned so the weights
// never change under a snapshot), `dtype`, `task`, `threshold` (minimum
// score, default 0.3), optionally `labels` to rename a model's labels to
// plain words (`{ "pottedplant": "potted plant" }`), and `join_phrases` for
// Grounding DINO, which takes one prompt in its own format, "dog . car .",
// rather than a list of labels (a list errors in the ONNX export).
//
// Vars: `image`; `find` (the phrases to look for, for zero-shot models).
//
// Output matches assertions/regions.ts: {"boxes": [{label, score, box}]} with
// boxes as fractions of the image size. Metadata: detect_ms, load_ms (first
// case only), rss_mb (process memory after detecting, an upper bound on the
// model's footprint), boxes (how many came back).
import { RawImage, pipeline } from '@huggingface/transformers'

interface Config {
  model: string
  revision: string
  dtype?: 'fp32' | 'fp16' | 'q8' | 'int8' | 'uint8' | 'q4' | 'bnb4' | 'q4f16'
  task: 'object-detection' | 'zero-shot-object-detection'
  threshold?: number
  labels?: Record<string, string>
  join_phrases?: boolean
}

interface Detection {
  score: number
  label: string
  box: { xmin: number; ymin: number; xmax: number; ymax: number }
}

type Detector = (image: RawImage, ...args: unknown[]) => Promise<Detection[]>

const loaded = new Map<string, Promise<Detector>>()

/** The image in a promptfoo var (a data URL) as a RawImage. */
export async function imageOf(dataUrl: string | undefined): Promise<RawImage> {
  if (!dataUrl) throw new Error('vars.image is missing')
  const base64 = dataUrl.replace(/^data:image\/[a-z]+;base64,/, '')
  const mime = /^data:(image\/[a-z]+);/.exec(dataUrl)?.[1] ?? 'image/jpeg'
  return RawImage.fromBlob(new Blob([Buffer.from(base64, 'base64')], { type: mime }))
}

export default class RegionDetector {
  private readonly config: Config

  constructor(options: { config: Config }) {
    this.config = options.config
  }

  id(): string {
    return `region-detector:${this.config.model}@${this.config.revision.slice(0, 7)}`
  }

  async callApi(_prompt: string, context: { vars: { image?: string; find?: string[] } }) {
    try {
      const { model, revision, dtype = 'fp32', task, threshold = 0.3, labels = {} } = this.config
      const key = `${task}:${model}@${revision}:${dtype}`
      let loadMs: number | undefined
      if (!loaded.has(key)) {
        const t = performance.now()
        const p = pipeline(task, model, { revision, dtype }) as unknown as Promise<Detector>
        loaded.set(key, p)
        await p
        loadMs = performance.now() - t
      }
      const detect = await loaded.get(key)!
      const image = await imageOf(context.vars.image)
      const t = performance.now()
      let found: Detection[]
      if (task === 'zero-shot-object-detection') {
        const find = context.vars.find ?? []
        if (find.length === 0) throw new Error('vars.find is empty: a zero-shot detector needs phrases to look for')
        const prompts = this.config.join_phrases ? [`${find.join(' . ')} .`] : find
        found = await detect(image, prompts, { threshold, percentage: true })
      } else {
        found = await detect(image, { threshold, percentage: true })
      }
      const detectMs = performance.now() - t
      const boxes = found.map((d) => ({
        label: labels[d.label] ?? d.label,
        score: Math.round(d.score * 1000) / 1000,
        box: [d.box.xmin, d.box.ymin, d.box.xmax, d.box.ymax].map((n) => Math.round(n * 10000) / 10000),
      }))
      return {
        output: JSON.stringify({ boxes }),
        metadata: {
          detect_ms: detectMs,
          ...(loadMs === undefined ? {} : { load_ms: loadMs }),
          rss_mb: process.memoryUsage().rss / 2 ** 20,
          boxes: boxes.length,
        },
      }
    } catch (err) {
      return { error: String(err) }
    }
  }
}
