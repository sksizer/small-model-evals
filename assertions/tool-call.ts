// promptfoo `javascript` assertion for the orchestrate suite. promptfoo's
// Ollama provider returns tool calls in OpenAI shape, either as the whole
// output or under `tool_calls` when the model also wrote text.
//
// `vars.tool` is the tool the model must call, or `none` when it should
// answer directly. Half credit for the right tool, full credit when every
// argument in `vars.args` matches too.
import { gradeFields, type Expected, type GradingResult } from './match.ts'

interface ToolCall {
  function: { name: string; arguments: string }
}

function toolCalls(output: unknown): ToolCall[] {
  if (Array.isArray(output)) return output as ToolCall[]
  if (output && typeof output === 'object' && 'tool_calls' in output) {
    return (output as { tool_calls: ToolCall[] }).tool_calls
  }
  return []
}

export default function (
  output: unknown,
  context: { vars: { tool: string; args?: Record<string, Expected> } },
): GradingResult {
  const { tool, args = {} } = context.vars
  const calls = toolCalls(output)
  if (tool === 'none') {
    return calls.length === 0
      ? { pass: true, score: 1, reason: 'answered without a tool' }
      : { pass: false, score: 0, reason: `called ${calls.map((c) => c.function.name).join(', ')}` }
  }
  const call = calls.find((c) => c.function.name === tool)
  if (!call) {
    const got = calls.length === 0 ? 'no tool call' : calls.map((c) => c.function.name).join(', ')
    return { pass: false, score: 0, reason: `wanted ${tool}, got ${got}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(call.function.arguments)
  } catch {
    return { pass: false, score: 0.5, reason: `${tool} called with unparseable arguments` }
  }
  const fields = gradeFields(args, parsed)
  return { ...fields, score: 0.5 + fields.score / 2 }
}
