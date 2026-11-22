// Endpoint check: does Ollama's OpenAI-compatible /v1/chat/completions, the path the dashboard's AI SDK client
// (createOpenAICompatible) uses, (1) constrain a reply with `response_format` of type json_schema, and (2) deliver
// streamed tool calls whole? Per model, pass or fail for each, with the evidence.
//
//   bun scripts/endpoint-check.ts [--default-reasoning] [--models gemma4:e4b,qwen3.5:4b,qwen3.5:9b] [--runs 3] [--write results/notes/<file>.md]
//
// Constrained JSON: the prompt asks for free prose and offers no hint of the shape, so only the constraint can
// produce a reply that parses, has exactly the schema's keys and keeps `kind` inside its enum. Pass: every run does.
// Streamed tool calls: the request has stream: true and one tool, and the prompt names two foods. Pass: at least one
// tool call arrives, each delta that carries a call holds its name and a complete JSON `arguments` string with the
// required `query` (not fragments to be joined), and the stream ends with finish_reason tool_calls.
import { parseArgs } from 'node:util'
import { writeFileSync } from 'node:fs'
import { BASE } from '../providers/ollama-stream.ts'

const { values } = parseArgs({
  options: { models: { type: 'string', default: 'gemma4:e4b,qwen3.5:4b,qwen3.5:9b' }, runs: { type: 'string', default: '3' }, 'default-reasoning': { type: 'boolean' }, write: { type: 'string' } },
})
const MODELS = values.models!.split(',')
const RUNS = Number(values.runs)
/** Sent as reasoning_effort: none unless --default-reasoning, which leaves the model's own thinking default (what a client that sets nothing gets). */
const REASONING = values['default-reasoning'] ? {} : { reasoning_effort: 'none' }

const SCHEMA = {
  type: 'object',
  required: ['kind', 'foods'],
  additionalProperties: false,
  properties: { kind: { type: 'string', enum: ['meal', 'snack', 'drink'] }, foods: { type: 'array', items: { type: 'string' } } },
}
const TOOL = {
  type: 'function',
  function: {
    name: 'search_foods',
    description: 'Search the food database by keywords. Returns the best matching foods.',
    parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string', description: 'Keywords' } } },
  },
}

/** A request that takes longer than this fails the check (a thinking model can run past it). */
const TIMEOUT_MS = 300_000

const post = (body: Record<string, unknown>) =>
  fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) })

async function constrained(model: string): Promise<{ ok: boolean; detail: string }> {
  const bad: string[] = []
  for (let i = 0; i < RUNS; i++) {
    const res = await post({
      model,
      temperature: 0,
      ...REASONING,
      messages: [{ role: 'user', content: 'Tell me in a friendly sentence or two what a good breakfast is, and explain why. Do not use JSON.' }],
      response_format: { type: 'json_schema', json_schema: { name: 'meal', strict: true, schema: SCHEMA } },
    })
    if (!res.ok) {
      bad.push(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`)
      continue
    }
    const content = ((await res.json()) as { choices: { message: { content: string } }[] }).choices[0]?.message.content ?? ''
    try {
      const v = JSON.parse(content) as { kind?: unknown; foods?: unknown }
      const keys = Object.keys(v).sort().join(',')
      if (keys !== 'foods,kind') bad.push(`keys ${keys}`)
      else if (!['meal', 'snack', 'drink'].includes(String(v.kind))) bad.push(`kind ${String(v.kind)} outside the enum`)
      else if (!Array.isArray(v.foods) || v.foods.some((f) => typeof f !== 'string')) bad.push('foods is not a string list')
    } catch {
      bad.push(`not JSON: ${content.slice(0, 80).replace(/\n/g, ' ')}`)
    }
  }
  return { ok: bad.length === 0, detail: bad.length === 0 ? `${RUNS}/${RUNS} replies parsed and fit the schema` : `${RUNS - bad.length}/${RUNS} fit; ${bad[0]}` }
}

interface Delta {
  tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
}

async function streamedToolCalls(model: string): Promise<{ ok: boolean; detail: string }> {
  const res = await post({
    model,
    stream: true,
    temperature: 0,
    ...REASONING,
    messages: [{ role: 'user', content: 'Look up the foods "banana" and "cheddar cheese" with the search_foods tool.' }],
    tools: [TOOL],
  })
  if (!res.ok || !res.body) return { ok: false, detail: `HTTP ${res.status} ${(await res.text()).slice(0, 120)}` }
  const carrying: { name?: string; arguments?: string }[] = []
  let finish = ''
  let buffer = ''
  const decoder = new TextDecoder()
  const take = (line: string) => {
    if (!line.startsWith('data:') || line.includes('[DONE]')) return
    const chunk = JSON.parse(line.slice(5)) as { choices?: { delta?: Delta; finish_reason?: string | null }[] }
    for (const c of chunk.choices ?? []) {
      for (const t of c.delta?.tool_calls ?? []) carrying.push({ ...(t.function?.name === undefined ? {} : { name: t.function.name }), ...(t.function?.arguments === undefined ? {} : { arguments: t.function.arguments }) })
      if (c.finish_reason) finish = c.finish_reason
    }
  }
  for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(part, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    lines.forEach(take)
  }
  take(buffer)
  if (carrying.length === 0) return { ok: false, detail: `no tool call in the stream (finish_reason ${finish || 'none'})` }
  const whole = carrying.filter((t) => {
    try {
      return t.name === 'search_foods' && typeof (JSON.parse(t.arguments ?? '') as { query?: unknown }).query === 'string'
    } catch {
      return false
    }
  })
  const ok = whole.length === carrying.length && finish === 'tool_calls'
  return { ok, detail: `${carrying.length} tool-call delta${carrying.length === 1 ? '' : 's'}, ${whole.length} whole (name and complete JSON arguments); finish_reason ${finish || 'none'}` }
}

const rows: { model: string; json: { ok: boolean; detail: string }; tools: { ok: boolean; detail: string } }[] = []
for (const model of MODELS) {
  console.log(`\n=== ${model}`)
  const guard = async (f: (m: string) => Promise<{ ok: boolean; detail: string }>) => {
    try {
      return await f(model)
    } catch (err) {
      return { ok: false, detail: String(err) }
    }
  }
  const json = await guard(constrained)
  console.log(`constrained JSON: ${json.ok ? 'PASS' : 'FAIL'} - ${json.detail}`)
  const tools = await guard(streamedToolCalls)
  console.log(`streamed tool calls: ${tools.ok ? 'PASS' : 'FAIL'} - ${tools.detail}`)
  rows.push({ model, json, tools })
}

const md = [
  '| Model | `response_format` json_schema constrains the reply | Streamed tool calls arrive whole |',
  '| --- | --- | --- |',
  ...rows.map((r) => `| ${r.model} | ${r.json.ok ? 'pass' : 'FAIL'}: ${r.json.detail} | ${r.tools.ok ? 'pass' : 'FAIL'}: ${r.tools.detail} |`),
].join('\n')
console.log(`\n${md}`)
if (values.write) writeFileSync(values.write, `${md}\n`)
