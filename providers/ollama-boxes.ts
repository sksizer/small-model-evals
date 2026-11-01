// promptfoo custom provider: asks an Ollama vision model to box things, for
// comparison with the small detectors in the regions suites.
//
// The model is asked for every instance of each phrase in the case's `find`
// list, as JSON constrained by a schema: {"boxes": [{"label", "box_2d":
// [x0, y0, x1, y1]}]}, the label limited to those phrases (left free, models
// label a text line with its words) with coordinates on a 0-1000 grid over the image (the
// convention Qwen's vision models are trained on; other models are told the
// same in the prompt). Coordinates are divided by 1000, so the output matches
// assertions/regions.ts: {"boxes": [{label, box}]} as fractions.
//
// Config: `model` (Ollama tag), `think`, `num_ctx`, `num_predict` (default
// 1024; a long list of boxes is the only long reply), `order`: `xyxy`
// (default; Qwen, LFM) or `yxyx` for models trained on [y0, x0, y1, x1]
// (Gemma's documented box_2d order). The prompt asks for [x0, y0, x1, y1]
// either way; `order` says how the reply is read. `ask` replaces the phrase
// list in the request when the phrases alone are ambiguous (regions-text asks
// for each line of text: asked for "text", models box the whole page); labels
// stay limited to the `find` phrases.
const BASE = process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434'

interface Config {
  model: string
  think?: boolean
  num_ctx?: number
  num_predict?: number
  order?: 'xyxy' | 'yxyx'
  ask?: string
}

const schema = (find: string[]) => ({
  type: 'object',
  required: ['boxes'],
  properties: {
    boxes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['label', 'box_2d'],
        properties: {
          label: { type: 'string', enum: find },
          box_2d: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 },
        },
      },
    },
  },
})

export default class OllamaBoxes {
  private readonly config: Config

  constructor(options: { config: Config }) {
    this.config = options.config
  }

  id(): string {
    return `ollama-boxes:${this.config.model}`
  }

  async callApi(_prompt: string, context: { vars: { image?: string; find?: string[] } }) {
    try {
      const { image, find = [] } = context.vars
      if (!image) throw new Error('vars.image is missing')
      if (find.length === 0) throw new Error('vars.find is empty')
      const ask =
        `Find every ${this.config.ask ?? find.map((f) => `"${f}"`).join(', ')} in this image. ` +
        `For each one, give its label (one of: ${find.map((f) => `"${f}"`).join(', ')}) and its bounding box as box_2d: [x0, y0, x1, y1], ` +
        'with coordinates from 0 to 1000 relative to the image width and height, top left origin. ' +
        'Give an empty list when there are none. Reply as JSON: {"boxes": [{"label": "...", "box_2d": [x0, y0, x1, y1]}]}.'
      const res = await fetch(`${BASE}/api/chat`, {
        method: 'POST',
        body: JSON.stringify({
          model: this.config.model,
          stream: false,
          ...(this.config.think === undefined ? {} : { think: this.config.think }),
          options: { temperature: 0, num_ctx: this.config.num_ctx ?? 8192, num_predict: this.config.num_predict ?? 1024 },
          format: schema(find),
          messages: [{ role: 'user', content: ask, images: [image.replace(/^data:image\/[a-z]+;base64,/, '')] }],
        }),
      })
      if (!res.ok) throw new Error(`/api/chat: ${res.status} ${await res.text()}`)
      const body = (await res.json()) as { message: { content: string }; prompt_eval_count?: number; eval_count?: number }
      let raw: { boxes?: { label?: unknown; box_2d?: unknown }[] }
      try {
        raw = JSON.parse(body.message.content) as typeof raw
      } catch {
        return { output: body.message.content }
      }
      const boxes = (raw.boxes ?? [])
        .filter((b) => typeof b.label === 'string' && Array.isArray(b.box_2d) && b.box_2d.length === 4)
        .map((b) => {
          const v = (b.box_2d as number[]).map((n) => Math.round((Number(n) / 1000) * 10000) / 10000)
          return { label: b.label as string, box: this.config.order === 'yxyx' ? [v[1]!, v[0]!, v[3]!, v[2]!] : v }
        })
      return {
        output: JSON.stringify({ boxes }),
        tokenUsage: {
          prompt: body.prompt_eval_count ?? 0,
          completion: body.eval_count ?? 0,
          total: (body.prompt_eval_count ?? 0) + (body.eval_count ?? 0),
        },
        metadata: { boxes: boxes.length },
      }
    } catch (err) {
      return { error: String(err) }
    }
  }
}
