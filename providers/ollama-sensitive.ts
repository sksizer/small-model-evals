// promptfoo custom provider for the sensitive suite: a vision chat model looks
// at one image and rates every category in assertions/sensitive-levels.ts.
// One call per image, the reply constrained to a JSON schema:
//   { categories: { <id>: { present: boolean, risk: number 0..1 } } }
// with a short definition of each category (DEFINITIONS, shared with the site)
// in the prompt. Temperature 0, thinking off.
//
// Output: {"categories": {<id>: risk}, "level": "public|review|private",
// "raw": {<id>: {present, risk}}}. `categories` is the model's own risk per
// category (a missing or malformed entry counts as 0), `level` is
// levelFromRisks (categories with risk >= 0.5, then levelOf), `raw` keeps the
// model's reply as given so a threshold sweep or a present/risk disagreement
// can be read later. assertions/sensitive.ts scores it.
//
// Config: `model` (Ollama tag), `think`, `num_ctx`. Vars: `image`.
// A reply cut off at the token cap (qwen3.5:4b, on 5 of 108 images, wrote newlines
// after the first key until the cap) is asked for once more with a repeat penalty
// of 1.2, which ends the loop; `retried` is then 1 and both calls' time counts.
//
// Metadata: classify_ms (the server's time for the call(s) without model load),
// load_ms, loaded_bytes (the model's size in memory, from /api/ps), retried (0 or 1).
import { CATEGORIES, DEFINITIONS, levelFromRisks, type Category } from '../assertions/sensitive-levels.ts'

const BASE = process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434'
const NS_PER_MS = 1e6

interface Config {
  model: string
  think?: boolean
  num_ctx?: number
}

export interface Rated {
  categories: Record<Category, number>
  level: string
  raw: Record<string, { present?: unknown; risk?: unknown }>
}

export const SYSTEM_PROMPT = `You screen photos before they leave a person's device. For every category below, say whether the image shows it and how risky it is to share the image because of it (risk 0 = none, 1 = certain).

Categories:
${CATEGORIES.map((c) => `- ${c}: ${DEFINITIONS[c]}`).join('\n')}

Rate only what is visible. Blank templates, artworks, public web pages and swimwear at a beach or pool are not sensitive. Reply as JSON only.`

const SCHEMA = {
  type: 'object',
  required: ['categories'],
  properties: {
    categories: {
      type: 'object',
      required: [...CATEGORIES],
      properties: Object.fromEntries(
        CATEGORIES.map((c) => [c, { type: 'object', required: ['present', 'risk'], properties: { present: { type: 'boolean' }, risk: { type: 'number', minimum: 0, maximum: 1 } } }]),
      ),
    },
  },
}

const stripDataUrl = (s: string) => s.replace(/^data:image\/[a-z]+;base64,/, '')

/** Turns the model's reply into risks and a level. A category it left out or garbled counts as risk 0. */
export function normalise(reply: unknown): Rated {
  const raw = ((reply as { categories?: Rated['raw'] } | null)?.categories ?? {}) as Rated['raw']
  const categories = {} as Record<Category, number>
  for (const c of CATEGORIES) {
    const r = Number(raw[c]?.risk)
    categories[c] = Number.isFinite(r) ? Math.min(1, Math.max(0, Math.round(r * 1000) / 1000)) : 0
  }
  return { categories, level: levelFromRisks(categories), raw }
}

/** One Ollama call for one image. Returns the rated categories and the call's own timings. */
export async function rate(config: Config, image: string): Promise<{ rated: Rated; classifyMs: number; loadMs: number; loadedBytes: number | undefined; retried: boolean }> {
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${BASE}${path}`, { method: 'POST', body: JSON.stringify(body) })
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
    return res.json()
  }
  type Chat = { message: { content: string }; done_reason: string; total_duration: number; load_duration: number }
  const ask = (extra: Record<string, number>) =>
    post('/api/chat', {
      model: config.model,
      stream: false,
      ...(config.think === undefined ? {} : { think: config.think }),
      // The reply is eleven small objects; the cap stops a runaway one.
      options: { temperature: 0, num_ctx: config.num_ctx ?? 4096, num_predict: 1024, ...extra },
      format: SCHEMA,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: 'Rate this image.', images: [stripDataUrl(image)] },
      ],
    }) as Promise<Chat>
  let r = await ask({})
  let classifyMs = (r.total_duration - r.load_duration) / NS_PER_MS
  const loadMs = r.load_duration / NS_PER_MS
  const retried = r.done_reason === 'length'
  if (retried) {
    r = await ask({ repeat_penalty: 1.2 })
    classifyMs += (r.total_duration - r.load_duration) / NS_PER_MS
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(r.message.content)
  } catch {
    throw new Error(`reply is not JSON: ${r.message.content.slice(0, 200)}`)
  }
  const ps = (await (await fetch(`${BASE}/api/ps`)).json()) as { models: { name: string; size: number }[] }
  return {
    rated: normalise(parsed),
    classifyMs,
    loadMs,
    loadedBytes: ps.models.find((m) => m.name === config.model)?.size,
    retried,
  }
}

export default class OllamaSensitive {
  private readonly config: Config

  constructor(options: { config: Config }) {
    this.config = options.config
  }

  id(): string {
    return `ollama-sensitive:${this.config.model}`
  }

  async callApi(_prompt: string, context: { vars: { image?: string } }) {
    try {
      if (!context.vars.image) throw new Error('vars.image is missing')
      const { rated, classifyMs, loadMs, loadedBytes, retried } = await rate(this.config, context.vars.image)
      return {
        output: JSON.stringify(rated),
        metadata: { classify_ms: classifyMs, load_ms: loadMs, retried: retried ? 1 : 0, ...(loadedBytes === undefined ? {} : { loaded_bytes: loadedBytes }) },
      }
    } catch (err) {
      return { error: String(err) }
    }
  }
}
