// promptfoo custom provider for the shaped food lookups (suites food-shape-*): the same job as
// providers/ollama-food-agent.ts, the same database and the same answer, but no tool loop.
//
//   1. Shape: one call, no tools, reply constrained to `items[{text, query, quantity, unit}]` (the prompt is the
//      suite's, so it is part of the snapshot).
//   2. Search: code runs providers/food-search.ts on each item's `query`.
//   3. Pick, by `variant`:
//        top     code takes the top match.
//        choose  one more constrained call sees each item's top five and returns id and grams.
//        hybrid  code takes the top match when its score is at least `ratio` times the second's (`leads`), else that
//                item goes to the same choose call; no call at all when every item is decided by code.
//   4. Grams from code (`toGrams`, the food's portions) for every item code picked.
//
// Output is the loop's JSON, `{"answer": {"items": [{text, fdc_id, grams}]}, "searches": [queries]}`, so
// assertions/food.ts scores it unchanged, plus `shaped` (the first call's items) and `decided` (per item: who
// picked, the top and second search scores, how the grams were reached).
// Metadata (ledger metrics): searches, model_calls, items, code_decided, model_decided, fallback_decided (sent to the
// model but taken from the top match because its reply was unusable), and the timing of every
// call summed (providers/ollama-stream.ts).
//
// Config: `model`, `think`, `num_ctx`, `num_predict`, `db_sha256` as the loop's; `variant` (top | choose | hybrid);
// `ratio` (hybrid only: top score over second score; 1 is `top`, a ratio no match can reach is `choose`). A ratio rather
// than a score difference so it carries over to a search that scores on another scale; each item's top and second scores
// are recorded (`decided`) to re-derive it for one.
import { assertDb, searchScored, toHit, type Scored } from './food-search.ts'
import { leads, toGrams } from './food-shape.ts'
import { BASE, streamChat, sumTimings, type Timings } from './ollama-stream.ts'

const CANDIDATES = 5

type Variant = 'top' | 'choose' | 'hybrid'

interface Config {
  model: string
  think?: boolean
  num_ctx?: number
  num_predict?: number
  db_sha256: string
  variant: Variant
  /** hybrid only: the top score must be at least `ratio` times the second (see `leads`). */
  ratio?: number
}

interface Shaped {
  text: string
  query: string
  quantity: number | null
  unit: string
}

interface Message {
  role: string
  content: string
}

const SHAPE_SCHEMA = {
  type: 'object',
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['text', 'query', 'quantity', 'unit'],
        properties: {
          text: { type: 'string' },
          query: { type: 'string' },
          quantity: { type: ['number', 'null'] },
          unit: { type: 'string' },
        },
      },
    },
  },
}

const CHOOSE_SCHEMA = {
  type: 'object',
  required: ['choices'],
  properties: {
    choices: {
      type: 'array',
      items: {
        type: 'object',
        required: ['item', 'fdc_id', 'grams'],
        properties: { item: { type: 'integer' }, fdc_id: { type: ['integer', 'null'] }, grams: { type: ['number', 'null'] } },
      },
    },
  },
}

const CHOOSE_SYSTEM =
  'You match items from a food note to the USDA food database. For each numbered item you get the candidate foods, best search match first, each with its id, energy and portions in grams. For each item give: item, its number; fdc_id, the id of the candidate that is the same food as the item (prefer the plain, common form, and the cooking method the note names), or null when none of the candidates is that food; grams, the amount eaten in grams, converted with that food\'s portions, or estimated from a typical portion when the item gives a count or no amount.'

export default class OllamaFoodShape {
  private readonly config: Config

  constructor(options: { config: Config }) {
    this.config = options.config
  }

  id(): string {
    const c = this.config
    return `ollama-food-shape:${c.model}:${c.variant}${c.variant === 'hybrid' ? `:${c.ratio}` : ''}`
  }

  private async chat(messages: Message[], format: object) {
    const r = await streamChat(BASE, {
      model: this.config.model,
      messages,
      ...(this.config.think === undefined ? {} : { think: this.config.think }),
      options: { temperature: 0, num_ctx: this.config.num_ctx ?? 8192, num_predict: this.config.num_predict ?? 4096 },
      format,
    })
    return { content: r.content, timings: r.timings, prompt_eval_count: r.final.prompt_eval_count ?? 0, eval_count: r.final.eval_count ?? 0 }
  }

  async callApi(prompt: string) {
    try {
      const { variant, ratio = 1 } = this.config
      assertDb(this.config.db_sha256)
      const messages = JSON.parse(prompt) as Message[]
      const note = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
      const timings: Timings[] = []
      let tokens = { prompt: 0, completion: 0 }
      const count = (r: { timings: Timings; prompt_eval_count: number; eval_count: number }) => {
        timings.push(r.timings)
        tokens = { prompt: tokens.prompt + r.prompt_eval_count, completion: tokens.completion + r.eval_count }
      }

      const shapeReply = await this.chat(messages, SHAPE_SCHEMA)
      count(shapeReply)
      let shaped: Shaped[]
      try {
        const items = (JSON.parse(shapeReply.content) as { items: unknown }).items
        if (!Array.isArray(items)) throw new Error('no items')
        shaped = items.filter((s): s is Shaped => typeof s === 'object' && s !== null)
      } catch {
        return {
          output: JSON.stringify({ answer: { items: [] }, searches: [], raw: shapeReply.content }),
          tokenUsage: { prompt: tokens.prompt, completion: tokens.completion, total: tokens.prompt + tokens.completion },
          metadata: { ...sumTimings(timings), searches: 0, model_calls: 1, items: 0, code_decided: 0, model_decided: 0 },
        }
      }

      const searches = shaped.map((s) => String(s.query ?? ''))
      const found: Scored[][] = searches.map((q) => searchScored(q).slice(0, CANDIDATES))
      const byModel = shaped.map((_, i) => variant === 'choose' ? found[i]!.length > 0 : variant === 'hybrid' && found[i]!.length > 0 && !leads(found[i]!.map((x) => x.score), ratio))

      const choices = new Map<number, { fdc_id: number | null; grams: number | null }>()
      if (byModel.some(Boolean)) {
        const asked = byModel.flatMap((m, i) => (m ? [i] : []))
        const lines = asked.map((i) => {
          const s = shaped[i]!
          const amount = s.quantity === null || s.quantity === undefined ? 'no amount given' : `${s.quantity} ${s.unit}`.trim()
          const cands = found[i]!.map(({ food }) => {
            const h = toHit(food)
            return `  - ${h.fdc_id}: ${h.name} (${h.kcal_per_100g} kcal/100 g; ${h.portions.join('; ') || 'no portions'})`
          })
          return `Item ${i}: "${s.text}" (${amount})\n${cands.join('\n')}`
        })
        const chooseReply = await this.chat(
          [
            { role: 'system', content: CHOOSE_SYSTEM },
            { role: 'user', content: `Note: ${note}\n\n${lines.join('\n\n')}` },
          ],
          CHOOSE_SCHEMA,
        )
        count(chooseReply)
        try {
          for (const c of (JSON.parse(chooseReply.content) as { choices: { item: number; fdc_id: number | null; grams: number | null }[] }).choices) {
            choices.set(c.item, { fdc_id: c.fdc_id, grams: c.grams })
          }
        } catch {
          // an unreadable choose reply leaves every asked item to the top match below
        }
      }

      const decided: Record<string, unknown>[] = []
      const items = shaped.map((s, i) => {
        const cands = found[i]!
        const top = cands[0]
        const gap = { top: top?.score ?? null, second: cands[1]?.score ?? null }
        if (!top) {
          decided.push({ text: s.text, by: 'none', ...gap })
          return { text: s.text, fdc_id: null, grams: null }
        }
        const chosen = byModel[i] ? choices.get(i) : undefined
        if (chosen && (chosen.fdc_id === null || cands.some((c) => c.food.id === chosen.fdc_id))) {
          const picked = cands.find((c) => c.food.id === chosen.fdc_id)
          const modelGrams = typeof chosen.grams === 'number' && Number.isFinite(chosen.grams)
          const amount = picked && !modelGrams ? toGrams(picked.food, s.quantity, s.unit) : null
          decided.push({ text: s.text, by: 'model', ...gap, ...(amount ? { basis: amount.basis } : {}) })
          return { text: s.text, fdc_id: chosen.fdc_id, grams: amount ? Math.round(amount.grams * 10) / 10 : chosen.grams }
        }
        const amount = toGrams(top.food, s.quantity, s.unit)
        decided.push({ text: s.text, by: byModel[i] ? 'code-fallback' : 'code', ...gap, basis: amount.basis })
        return { text: s.text, fdc_id: top.food.id, grams: Math.round(amount.grams * 10) / 10 }
      })

      return {
        output: JSON.stringify({ answer: { items }, searches, shaped, decided }),
        tokenUsage: { prompt: tokens.prompt, completion: tokens.completion, total: tokens.prompt + tokens.completion },
        metadata: {
          ...sumTimings(timings),
          searches: searches.length,
          model_calls: timings.length,
          items: items.length,
          code_decided: decided.filter((d) => d['by'] === 'code').length,
          model_decided: decided.filter((d) => d['by'] === 'model').length,
          fallback_decided: decided.filter((d) => d['by'] === 'code-fallback').length,
        },
      }
    } catch (err) {
      return { error: String(err) }
    }
  }
}
