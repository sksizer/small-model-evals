// promptfoo custom provider for the food-lookup suite: runs a tool loop
// against Ollama. The model may call `search_foods` (keyword search over the
// USDA database, providers/food-search.ts) as often as it likes, up to
// MAX_TURNS; then one last call, constrained to the answer schema, asks for
// the final items.
//
// Output is JSON: `{"answer": <final reply>, "searches": [queries in order]}`,
// so a result shows how the model searched as well as what it chose.
// Metadata (recorded as ledger metrics): searches, turns.
//
// Config: `model` (Ollama tag), `think` (false for models that reason by
// default), `num_ctx`, and `db_sha256`: the database's hash, checked before
// every case so a changed database cannot pass for the one a snapshot names.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DEFAULT_DB, searchFoods } from './food-search.ts'

const BASE = process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434'
const MAX_TURNS = 8

interface Config {
  model: string
  think?: boolean
  num_ctx?: number
  db_sha256: string
}

interface Message {
  role: string
  content: string
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> | string } }[]
  tool_name?: string
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_foods',
      description:
        'Search the USDA food database by keywords. Returns up to 10 foods, best first, each with fdc_id, name, kcal_per_100g and household portions in grams.',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: { query: { type: 'string', description: 'Keywords, e.g. "egg whole raw" or "rice white cooked"' } },
      },
    },
  },
]

const ANSWER_SCHEMA = {
  type: 'object',
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['text', 'fdc_id', 'grams'],
        properties: {
          text: { type: 'string' },
          fdc_id: { type: ['integer', 'null'] },
          grams: { type: ['number', 'null'] },
        },
      },
    },
  },
}

const FINAL = 'Now give the final answer as JSON: {"items": [{"text", "fdc_id", "grams"}]}, one item per food or drink consumed.'

let checkedDb = ''

export default class OllamaFoodAgent {
  private readonly config: Config

  constructor(options: { config: Config }) {
    this.config = options.config
  }

  id(): string {
    return `ollama-food-agent:${this.config.model}`
  }

  private async chat(messages: Message[], extra: Record<string, unknown>) {
    const res = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      body: JSON.stringify({
        model: this.config.model,
        messages,
        stream: false,
        ...(this.config.think === undefined ? {} : { think: this.config.think }),
        // Caps a reply that repeats itself, so a case cannot stall the run.
        options: { temperature: 0, num_ctx: this.config.num_ctx ?? 8192, num_predict: 1024 },
        ...extra,
      }),
    })
    if (!res.ok) throw new Error(`/api/chat: ${res.status} ${await res.text()}`)
    return (await res.json()) as { message: Message; prompt_eval_count?: number; eval_count?: number }
  }

  async callApi(prompt: string) {
    try {
      if (checkedDb !== this.config.db_sha256) {
        const got = createHash('sha256').update(readFileSync(DEFAULT_DB)).digest('hex')
        if (got !== this.config.db_sha256) throw new Error(`foods.jsonl sha256 ${got} is not the configured ${this.config.db_sha256}`)
        checkedDb = got
      }
      const messages = JSON.parse(prompt) as Message[]
      const searches: string[] = []
      let tokens = { prompt: 0, completion: 0 }
      const count = (r: { prompt_eval_count?: number; eval_count?: number }) => {
        tokens = { prompt: tokens.prompt + (r.prompt_eval_count ?? 0), completion: tokens.completion + (r.eval_count ?? 0) }
      }
      let turns = 0
      for (; turns < MAX_TURNS; turns++) {
        const res = await this.chat(messages, { tools: TOOLS })
        count(res)
        messages.push(res.message)
        const calls = res.message.tool_calls ?? []
        if (calls.length === 0) break
        for (const call of calls) {
          const args = typeof call.function.arguments === 'string' ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : call.function.arguments
          const query = String(args['query'] ?? '')
          const result = call.function.name === 'search_foods' ? searchFoods(query) : { error: `unknown tool ${call.function.name}` }
          if (call.function.name === 'search_foods') searches.push(query)
          messages.push({ role: 'tool', tool_name: call.function.name, content: JSON.stringify(result) })
        }
      }
      messages.push({ role: 'user', content: FINAL })
      const final = await this.chat(messages, { format: ANSWER_SCHEMA })
      count(final)
      let answer: unknown
      try {
        answer = JSON.parse(final.message.content)
      } catch {
        answer = final.message.content
      }
      return {
        output: JSON.stringify({ answer, searches }),
        tokenUsage: { prompt: tokens.prompt, completion: tokens.completion, total: tokens.prompt + tokens.completion },
        metadata: { searches: searches.length, turns: turns + 1 },
      }
    } catch (err) {
      return { error: String(err) }
    }
  }
}
