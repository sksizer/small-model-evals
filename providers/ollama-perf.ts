// promptfoo custom provider for the perf suite. promptfoo's built-in Ollama
// provider reports tokens and wall-clock latency only; this one also returns
// Ollama's own timings and the loaded model's memory from /api/ps, as
// response metadata that scripts/summarize.ts reads.
//
// Config: `model` (Ollama tag), `think` (send `think: false` to models that
// reason by default), `embed` (call /api/embed with a batch instead of chat).
// The test's `vars.num_ctx` sets the context window, so one suite measures
// memory at several sizes; Ollama reloads the model when it changes.

const BASE = process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434'
const OUTPUT_TOKENS = 256
const EMBED_BATCH = 64

interface Config {
  model: string
  think?: boolean
  embed?: boolean
}

interface CallContext {
  vars: { num_ctx?: number }
}

interface PsModel {
  name: string
  size: number
  size_vram: number
  context_length?: number
}

const NS_PER_MS = 1e6
const NS_PER_S = 1e9

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

async function loaded(model: string): Promise<PsModel | undefined> {
  const res = await fetch(`${BASE}/api/ps`)
  const { models } = (await res.json()) as { models: PsModel[] }
  return models.find((m) => m.name === model)
}

export default class OllamaPerf {
  private readonly config: Config

  constructor(options: { config: Config }) {
    this.config = options.config
  }

  id(): string {
    return `ollama-perf:${this.config.model}`
  }

  async callApi(prompt: string, context: CallContext) {
    const numCtx = context.vars.num_ctx ?? 8192
    try {
      const metadata = this.config.embed ? await this.embed(prompt, numCtx) : await this.chat(prompt, numCtx)
      const ps = await loaded(this.config.model)
      return {
        output: metadata.output,
        tokenUsage: metadata.tokenUsage,
        metadata: {
          ...metadata.timings,
          num_ctx: numCtx,
          loaded_bytes: ps?.size,
          vram_bytes: ps?.size_vram,
        },
      }
    } catch (err) {
      return { error: String(err) }
    }
  }

  private async chat(prompt: string, numCtx: number) {
    const r = await post<{
      message: { content: string }
      load_duration: number
      prompt_eval_count: number
      prompt_eval_duration: number
      eval_count: number
      eval_duration: number
    }>('/api/chat', {
      model: this.config.model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      ...(this.config.think === undefined ? {} : { think: this.config.think }),
      options: { num_ctx: numCtx, num_predict: OUTPUT_TOKENS, temperature: 0 },
    })
    return {
      output: r.message.content,
      tokenUsage: { prompt: r.prompt_eval_count, completion: r.eval_count, total: r.prompt_eval_count + r.eval_count },
      timings: {
        load_ms: r.load_duration / NS_PER_MS,
        prompt_tokens: r.prompt_eval_count,
        prompt_tps: r.prompt_eval_count / (r.prompt_eval_duration / NS_PER_S),
        output_tokens: r.eval_count,
        decode_tps: r.eval_count / (r.eval_duration / NS_PER_S),
      },
    }
  }

  // Embeds the prompt's paragraphs, repeated to a fixed batch, and reports
  // inputs per second over the server-side time.
  private async embed(prompt: string, numCtx: number) {
    const paragraphs = prompt.split(/\n\s*\n/).filter((p) => p.trim())
    const input = Array.from({ length: EMBED_BATCH }, (_, i) => paragraphs[i % paragraphs.length]!)
    const r = await post<{ embeddings: number[][]; total_duration: number; load_duration: number; prompt_eval_count: number }>(
      '/api/embed',
      { model: this.config.model, input, options: { num_ctx: numCtx } },
    )
    const runS = (r.total_duration - r.load_duration) / NS_PER_S
    return {
      output: `${r.embeddings.length} embeddings of ${r.embeddings[0]?.length ?? 0} dims`,
      tokenUsage: { prompt: r.prompt_eval_count, completion: 0, total: r.prompt_eval_count },
      timings: {
        load_ms: r.load_duration / NS_PER_MS,
        prompt_tokens: r.prompt_eval_count,
        prompt_tps: r.prompt_eval_count / runS,
        embeds_per_s: input.length / runS,
      },
    }
  }
}
