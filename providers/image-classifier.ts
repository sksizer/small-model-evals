// promptfoo custom provider for small image classifiers (ONNX, run in-process
// with transformers.js; no Ollama). Used by nudity-flag: a dedicated
// classifier is tens of times smaller than a vision chat model.
//
// Config: `model` (Hugging Face id), `revision` (commit, pinned so the weights
// never change under a snapshot), `dtype` (fp32, q8, q4...), `flag` (the
// labels that mean "flag it"), `question` (the answer's name, matching the
// suite's questions). The image is `vars.image`.
//
// Output matches providers/ollama-decide.ts, so assertions/decide.ts scores
// both: {"answers": {"<question>": {"value": "yes" | "no", "p": {yes, no}}}}.
// Metadata: classify_ms, load_ms (first case only), rss_mb (process memory
// after classifying, an upper bound on the model's footprint).
import { RawImage, pipeline, type ImageClassificationOutput } from '@huggingface/transformers'

export interface Config {
  model: string
  revision: string
  dtype?: 'fp32' | 'fp16' | 'q8' | 'int8' | 'uint8' | 'q4' | 'bnb4' | 'q4f16'
  flag: string[]
  question: string
}

type Classifier = (image: RawImage, options?: { top_k?: number | null }) => Promise<ImageClassificationOutput>

const loaded = new Map<string, Promise<Classifier>>()

/** Classifies one image (a data URL or base64) and returns the summed score of the `flag` labels; `loadMs` is set when this call paid for loading. Shared with providers/sensitive-composite.ts. */
export async function flagScore(c: Config, image: string | undefined): Promise<{ pFlag: number; classifyMs: number; loadMs?: number }> {
  const { model, revision, dtype = 'q8', flag } = c
  const key = `${model}@${revision}:${dtype}`
  let loadMs: number | undefined
  if (!loaded.has(key)) {
    const t = performance.now()
    const p = pipeline('image-classification', model, { revision, dtype }) as unknown as Promise<Classifier>
    loaded.set(key, p)
    await p
    loadMs = performance.now() - t
  }
  const classify = await loaded.get(key)!
  if (!image) throw new Error('vars.image is missing')
  const base64 = image.replace(/^data:image\/[a-z]+;base64,/, '')
  const mime = /^data:(image\/[a-z]+);/.exec(image)?.[1] ?? 'image/jpeg'
  const blob = new Blob([Buffer.from(base64, 'base64')], { type: mime })
  const t = performance.now()
  const scores = await classify(await RawImage.fromBlob(blob), { top_k: null })
  const classifyMs = performance.now() - t
  return { pFlag: scores.filter((s) => flag.includes(s.label)).reduce((a, s) => a + s.score, 0), classifyMs, ...(loadMs === undefined ? {} : { loadMs }) }
}

export default class ImageClassifier {
  private readonly config: Config

  constructor(options: { config: Config }) {
    this.config = options.config
  }

  id(): string {
    return `image-classifier:${this.config.model}@${this.config.revision.slice(0, 7)}`
  }

  async callApi(_prompt: string, context: { vars: { image?: string } }) {
    try {
      const { question } = this.config
      const { pFlag: pYes, classifyMs, loadMs } = await flagScore(this.config, context.vars.image)
      return {
        output: JSON.stringify({ answers: { [question]: { value: pYes >= 0.5 ? 'yes' : 'no', p: { yes: pYes, no: 1 - pYes } } } }),
        metadata: {
          classify_ms: classifyMs,
          ...(loadMs === undefined ? {} : { load_ms: loadMs }),
          rss_mb: process.memoryUsage().rss / 2 ** 20,
        },
      }
    } catch (err) {
      return { error: String(err) }
    }
  }
}
