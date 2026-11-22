// A streamed Ollama /api/chat call with full timing, shared by the chat-style
// providers (ollama-chat.ts, ollama-food-agent.ts, ollama-food-shape.ts, ollama-decide.ts, ollama-boxes.ts).
//
// promptfoo's built-in `ollama:chat:` provider records only wall-clock latency.
// Streaming lets this one also see when the first token arrives; Ollama's final
// chunk carries its own server-side timings. All of it comes back as numeric
// metrics, which promptfoo copies from `response.metadata` into the ledger's
// `metrics` (scripts/ledger.ts).
//
// Metrics (milliseconds unless named; a field is left out when Ollama did not report it):
//   ttft_ms          request start to the first content or tool-call chunk (includes model load and prompt processing)
//   ttft_think_ms    request start to the first thinking chunk; only when the model thought
//   load_ms          load_duration: time spent loading the model into memory (0 when it was already loaded)
//   prompt_tokens    prompt_eval_count      prompt_ms  prompt_eval_duration      prompt_tps  tokens per second
//   output_tokens    eval_count (thinking tokens included: Ollama does not split them)
//   decode_ms        eval_duration          decode_tps  tokens per second
//   think_tokens     APPROXIMATE: the number of streamed thinking chunks. Ollama exposes no thinking token count; a
//                    chunk is usually one token, so this is close but not exact. Only when the model thought.
//   total_ms         wall clock, request start to the last chunk
//   turn_ms          the same, named per turn for multi-turn providers (they sum it; see sumTimings)
export interface Timings {
  ttft_ms?: number
  ttft_think_ms?: number
  load_ms?: number
  prompt_tokens?: number
  prompt_ms?: number
  prompt_tps?: number
  output_tokens?: number
  decode_ms?: number
  decode_tps?: number
  think_tokens?: number
  total_ms: number
}

export interface ToolCall {
  function: { name: string; arguments: Record<string, unknown> | string }
}

/** The fields of Ollama's last chunk that this reads (durations are nanoseconds). */
interface Final {
  done_reason?: string
  load_duration?: number
  prompt_eval_count?: number
  prompt_eval_duration?: number
  eval_count?: number
  eval_duration?: number
  prompt_eval_cached_count?: number
}

export interface StreamResult {
  content: string
  thinking: string
  /** Every tool call, with `arguments` as Ollama sent it (an object). */
  toolCalls: ToolCall[]
  /** Ollama's final chunk (done: true). */
  final: Final
  timings: Timings
}

const NS_PER_MS = 1e6
const round = (n: number) => Math.round(n * 100) / 100

/** Streams one /api/chat request and returns the whole reply with its timings. Throws on an HTTP or in-stream error. */
export async function streamChat(base: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<StreamResult> {
  const start = performance.now()
  const timeout = Number(process.env['PROMPTFOO_EVAL_TIMEOUT_MS'])
  const signals = [...(signal ? [signal] : []), ...(timeout > 0 ? [AbortSignal.timeout(timeout)] : [])]
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
    ...(signals.length > 0 ? { signal: AbortSignal.any(signals) } : {}),
  })
  if (!res.ok) throw new Error(`/api/chat: ${res.status} ${await res.text()}`)
  if (!res.body) throw new Error('/api/chat: no response body')

  let content = ''
  let thinking = ''
  let thinkChunks = 0
  const toolCalls: ToolCall[] = []
  let final: Final = {}
  let ttft: number | undefined
  let ttftThink: number | undefined

  const take = (line: string) => {
    if (!line.trim()) return
    const chunk = JSON.parse(line) as {
      error?: string
      done?: boolean
      message?: { content?: string; thinking?: string; tool_calls?: ToolCall[] }
    } & Final
    if (chunk.error) throw new Error(`Ollama error: ${chunk.error}`)
    const m = chunk.message
    const now = performance.now() - start
    if (m?.thinking) {
      ttftThink ??= now
      thinking += m.thinking
      thinkChunks++
    }
    if (m?.content) {
      ttft ??= now
      content += m.content
    }
    if (m?.tool_calls?.length) {
      ttft ??= now
      toolCalls.push(...m.tool_calls)
    }
    if (chunk.done) final = chunk
  }

  const decoder = new TextDecoder()
  let buffer = ''
  for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(part, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    lines.forEach(take)
  }
  take(buffer + decoder.decode())
  const total = performance.now() - start

  const ms = (ns: number | undefined) => (ns === undefined ? undefined : round(ns / NS_PER_MS))
  const tps = (tokens: number | undefined, ns: number | undefined) => (tokens !== undefined && ns ? round(tokens / (ns / 1e9)) : undefined)
  const timings: Timings = {
    ...(ttft === undefined ? {} : { ttft_ms: round(ttft) }),
    ...(ttftThink === undefined ? {} : { ttft_think_ms: round(ttftThink), think_tokens: thinkChunks }),
    ...(final.load_duration === undefined ? {} : { load_ms: ms(final.load_duration)! }),
    ...(final.prompt_eval_count === undefined ? {} : { prompt_tokens: final.prompt_eval_count }),
    ...(final.prompt_eval_duration === undefined ? {} : { prompt_ms: ms(final.prompt_eval_duration)! }),
    ...(tps(final.prompt_eval_count, final.prompt_eval_duration) === undefined ? {} : { prompt_tps: tps(final.prompt_eval_count, final.prompt_eval_duration)! }),
    ...(final.eval_count === undefined ? {} : { output_tokens: final.eval_count }),
    ...(final.eval_duration === undefined ? {} : { decode_ms: ms(final.eval_duration)! }),
    ...(tps(final.eval_count, final.eval_duration) === undefined ? {} : { decode_tps: tps(final.eval_count, final.eval_duration)! }),
    total_ms: round(total),
  }
  return { content, thinking, toolCalls, final, timings }
}

/**
 * Timings of several turns as one: counts and durations add up, the rates are recomputed from the sums, and the
 * time to first token is the first turn's (the wait the user feels). Adds `turn_ms` (the sum of the turns' wall
 * clocks) and `turns`.
 */
export function sumTimings(turns: Timings[]): Record<string, number> {
  const sum = (k: keyof Timings) => turns.reduce((a, t) => a + (t[k] ?? 0), 0)
  const has = (k: keyof Timings) => turns.some((t) => t[k] !== undefined)
  const out: Record<string, number> = { turns: turns.length, turn_ms: round(sum('total_ms')), total_ms: round(sum('total_ms')) }
  for (const k of ['load_ms', 'prompt_tokens', 'prompt_ms', 'output_tokens', 'decode_ms', 'think_tokens'] as const) if (has(k)) out[k] = round(sum(k))
  if (turns[0]?.ttft_ms !== undefined) out['ttft_ms'] = turns[0].ttft_ms
  if (turns[0]?.ttft_think_ms !== undefined) out['ttft_think_ms'] = turns[0].ttft_think_ms
  if (out['prompt_tokens'] !== undefined && out['prompt_ms']) out['prompt_tps'] = round(out['prompt_tokens'] / (out['prompt_ms'] / 1000))
  if (out['output_tokens'] !== undefined && out['decode_ms']) out['decode_tps'] = round(out['output_tokens'] / (out['decode_ms'] / 1000))
  return out
}

/** Where Ollama listens. */
export const BASE = process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434'
