// promptfoo custom provider: Ollama /api/chat with full timing. A drop-in for
// promptfoo's built-in `ollama:chat:<tag>`, which records only wall-clock
// latency. Sends the same request (same options, same format and tools) and
// returns the same output, so scores do not change; the difference is that the
// reply is streamed, so it also records the time to first token, and that
// Ollama's own timings come back as metrics (providers/ollama-stream.ts lists them).
//
// Config: `model` (Ollama tag) plus what the built-in takes:
// - top-level request fields: `think`, `format`, `keep_alive`, `truncate`, `tools` (a list, or a `file://` path
//   to a YAML/JSON list of OpenAI-format tools, relative to the suite folder)
// - every other key (`temperature`, `num_ctx`, `num_predict`, `top_p`, ...) goes into Ollama's `options`
// - `passthrough` (extra request fields; `passthrough.options` merges into `options`)
// - `showThinking` (default true): prepend `Thinking: <trace>` to a text reply, as the built-in does
//
// Output, as the built-in returns it: the reply text; or, when the model called tools, the tool-call list
// `[{function: {name, arguments: "<JSON string>"}}]` (an object `{content, tool_calls}` when it also wrote text).
import { existsSync, readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { BASE, streamChat } from './ollama-stream.ts'

interface Config {
  model: string
  think?: boolean
  format?: unknown
  keep_alive?: string | number
  truncate?: boolean
  tools?: unknown
  passthrough?: { options?: Record<string, unknown>; [key: string]: unknown }
  showThinking?: boolean
  [option: string]: unknown
}

/** Config keys that are not Ollama sampling options: the request's own fields and this provider's settings. */
const NOT_OPTIONS = new Set(['model', 'think', 'format', 'keep_alive', 'truncate', 'tools', 'passthrough', 'showThinking', 'basePath'])

type Message = { role: string; content?: unknown; tool_calls?: { function?: { arguments?: unknown } }[] }

/** A prompt promptfoo rendered: a JSON list of chat messages, else one user message. */
function messagesOf(prompt: string): Message[] {
  try {
    const parsed = JSON.parse(prompt) as unknown
    if (Array.isArray(parsed)) return parsed as Message[]
    if (parsed && typeof parsed === 'object') return [parsed as Message]
  } catch {
    // not JSON: a plain prompt
  }
  return [{ role: 'user', content: prompt }]
}

/** Ollama wants a past tool call's arguments as an object, not the JSON string that outputs carry. */
function objectArguments(messages: Message[]): Message[] {
  return messages.map((m) => ({
    ...m,
    ...(Array.isArray(m.tool_calls)
      ? {
          tool_calls: m.tool_calls.map((c) => {
            const args = c.function?.arguments
            if (typeof args !== 'string') return c
            try {
              const parsed = JSON.parse(args) as unknown
              return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...c, function: { ...c.function, arguments: parsed } } : c
            } catch {
              return c
            }
          }),
        }
      : {}),
  }))
}

function toolsOf(tools: unknown): unknown {
  if (typeof tools !== 'string' || !tools.startsWith('file://')) return tools
  // promptfoo runs under node, not bun (no Bun.YAML here), with the suite folder as the working directory.
  const path = resolve(process.cwd(), tools.slice('file://'.length))
  if (!existsSync(path)) throw new Error(`tools file not found: ${path}`)
  const text = readFileSync(path, 'utf8')
  return extname(path) === '.json' ? JSON.parse(text) : parseYaml(text) as unknown
}

export default class OllamaChat {
  private readonly config: Config

  constructor(options: { config: Config }) {
    this.config = options.config
  }

  id(): string {
    return `ollama-chat:${this.config.model}`
  }

  async callApi(prompt: string, _context?: unknown, options?: { abortSignal?: AbortSignal }) {
    const c = this.config
    try {
      const { options: extraOptions = {}, ...extraRest } = c.passthrough ?? {}
      const sampling = Object.fromEntries(Object.entries(c).filter(([k]) => !NOT_OPTIONS.has(k)))
      const tools = c.tools ? toolsOf(c.tools) : undefined
      const r = await streamChat(
        BASE,
        {
          model: c.model,
          messages: objectArguments(messagesOf(prompt)),
          options: { ...sampling, ...extraOptions },
          ...(c.think === undefined ? {} : { think: c.think }),
          ...(c.keep_alive === undefined ? {} : { keep_alive: c.keep_alive }),
          ...(c.format === undefined ? {} : { format: c.format }),
          ...(c.truncate === undefined ? {} : { truncate: c.truncate }),
          ...(tools === undefined ? {} : { tools }),
          ...extraRest,
        },
        options?.abortSignal,
      )
      const calls = r.toolCalls
        .filter((t) => typeof t.function.name === 'string')
        .map((t) => ({ function: { name: t.function.name, arguments: typeof t.function.arguments === 'string' ? t.function.arguments : JSON.stringify(t.function.arguments ?? {}) } }))
      let output: unknown = r.content
      if (calls.length > 0) output = r.content.trim() ? { content: r.content, tool_calls: calls } : calls
      if (r.thinking && typeof output === 'string' && (c.showThinking ?? true)) output = output ? `Thinking: ${r.thinking}\n\n${output}` : `Thinking: ${r.thinking}`
      const prompt_ = r.final.prompt_eval_count
      const completion = r.final.eval_count
      return {
        output,
        ...(r.final.done_reason ? { finishReason: r.final.done_reason } : {}),
        ...(prompt_ === undefined && completion === undefined
          ? {}
          : { tokenUsage: { prompt: prompt_ ?? 0, completion: completion ?? 0, total: (prompt_ ?? 0) + (completion ?? 0), numRequests: 1 } }),
        metadata: { ...r.timings },
      }
    } catch (err) {
      return { error: `Ollama chat: ${String(err)}` }
    }
  }
}
