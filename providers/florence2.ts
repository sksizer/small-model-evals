// promptfoo custom provider for Florence-2 (Microsoft, MIT; ONNX, run
// in-process with transformers.js): one small vision model that boxes things
// on request. Used by the regions suites.
//
// `task` picks what it is asked:
// - `od`: <OD>, every object it can name; the scorer keeps the labels a case
//   asks about.
// - `grounding`: <CAPTION_TO_PHRASE_GROUNDING> once per phrase in the case's
//   `find` list; each box is labelled with the phrase it answers.
// - `ocr`: <OCR_WITH_REGION>, every line of text as a four-point box,
//   flattened to its bounding rectangle and labelled `text`.
//
// Config: `model` (Hugging Face id), `revision` (pinned commit), `dtype`
// (applied to all four ONNX parts), `task`, `max_new_tokens` (default 512).
//
// Output matches assertions/regions.ts: {"boxes": [{label, box}]} with boxes
// as fractions of the image size (the post-processor scales its location bins
// by the size it is given; it is given 1 x 1). Metadata: detect_ms, load_ms
// (first case only), rss_mb, boxes.
import { AutoProcessor, Florence2ForConditionalGeneration, type Tensor } from '@huggingface/transformers'
import { imageOf } from './region-detector.ts'

interface Config {
  model: string
  revision: string
  dtype?: 'fp32' | 'fp16' | 'q8' | 'int8' | 'uint8' | 'q4' | 'bnb4' | 'q4f16'
  task: 'od' | 'grounding' | 'ocr'
  max_new_tokens?: number
}

const PROMPTS = { od: '<OD>', grounding: '<CAPTION_TO_PHRASE_GROUNDING>', ocr: '<OCR_WITH_REGION>' } as const

type Loaded = { model: Florence2ForConditionalGeneration; processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>> }
const loaded = new Map<string, Promise<Loaded>>()

type Parsed = Record<string, { labels: string[]; bboxes?: number[][]; quad_boxes?: number[][] }>

export default class Florence2 {
  private readonly config: Config

  constructor(options: { config: Config }) {
    this.config = options.config
  }

  id(): string {
    return `florence2:${this.config.model}@${this.config.revision.slice(0, 7)}:${this.config.task}`
  }

  private async ask(m: Loaded, image: Awaited<ReturnType<typeof imageOf>>, task: string, text = ''): Promise<{ labels: string[]; boxes: number[][] }> {
    const prompts = (m.processor as unknown as { construct_prompts(t: string): string[] }).construct_prompts(task + text)
    const inputs = await (m.processor as unknown as (img: unknown, t: string[]) => Promise<Record<string, Tensor>>)(image, prompts)
    const ids = (await m.model.generate({ ...inputs, max_new_tokens: this.config.max_new_tokens ?? 512 })) as Tensor
    const decoded = (m.processor as unknown as { batch_decode(t: Tensor, o: object): string[] }).batch_decode(ids, { skip_special_tokens: false })[0]!
    const parsed = (m.processor as unknown as { post_process_generation(t: string, task: string, size: [number, number]): Parsed }).post_process_generation(
      decoded,
      task,
      [1, 1],
    )[task]!
    return { labels: parsed.labels, boxes: parsed.bboxes ?? parsed.quad_boxes ?? [] }
  }

  /** The loaded model, and how long loading took when this call paid for it. */
  private async model(): Promise<{ m: Loaded; loadMs?: number }> {
    const { model, revision, dtype = 'q8' } = this.config
    const key = `${model}@${revision}:${dtype}`
    let loadMs: number | undefined
    if (!loaded.has(key)) {
      const t = performance.now()
      const p = Promise.all([
        Florence2ForConditionalGeneration.from_pretrained(model, { revision, dtype }),
        AutoProcessor.from_pretrained(model, { revision }),
      ]).then(([m, processor]) => ({ model: m as Florence2ForConditionalGeneration, processor }))
      loaded.set(key, p)
      await p
      loadMs = performance.now() - t
    }
    return { m: await loaded.get(key)!, ...(loadMs === undefined ? {} : { loadMs }) }
  }

  /** The text of every line <OCR_WITH_REGION> reads, in reading order. Shared with providers/sensitive-composite.ts. */
  async ocrText(dataUrl: string | undefined): Promise<{ lines: string[]; ocrMs: number; loadMs?: number }> {
    const { m, loadMs } = await this.model()
    const image = await imageOf(dataUrl)
    const t = performance.now()
    const r = await this.ask(m, image, PROMPTS.ocr)
    return { lines: r.labels.map((l) => l.trim()).filter(Boolean), ocrMs: performance.now() - t, ...(loadMs === undefined ? {} : { loadMs }) }
  }

  async callApi(_prompt: string, context: { vars: { image?: string; find?: string[] } }) {
    try {
      const { task } = this.config
      const { m, loadMs } = await this.model()
      const image = await imageOf(context.vars.image)
      const t = performance.now()
      const boxes: { label: string; box: number[] }[] = []
      const round = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 10000) / 10000
      if (task === 'grounding') {
        const find = context.vars.find ?? []
        if (find.length === 0) throw new Error('vars.find is empty: grounding needs phrases to look for')
        for (const phrase of find) {
          const r = await this.ask(m, image, PROMPTS.grounding, phrase)
          for (const b of r.boxes) boxes.push({ label: phrase, box: b.map(round) })
        }
      } else {
        const r = await this.ask(m, image, PROMPTS[task])
        r.boxes.forEach((b, i) => {
          if (task === 'ocr') {
            const xs = b.filter((_, j) => j % 2 === 0)
            const ys = b.filter((_, j) => j % 2 === 1)
            boxes.push({ label: 'text', box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(round) })
          } else boxes.push({ label: r.labels[i] ?? '', box: b.map(round) })
        })
      }
      const detectMs = performance.now() - t
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
