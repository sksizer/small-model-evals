# Endpoint check: Ollama OpenAI-compatible `/v1/chat/completions` (2026-11-21)

Task T-HGSL, AC-3. Script: `bun scripts/endpoint-check.ts` (add `--default-reasoning` for the second table).
Ollama 0.40.16 on the Apple M4, 16 GB. Two questions per model, the path the dashboard's `createOpenAICompatible`
client uses:

1. Does `response_format: {type: "json_schema", strict: true}` constrain the reply? The prompt asks for friendly
   prose and says nothing of the shape, so only the constraint can produce a reply with exactly the schema's keys
   and an enum value. Pass: 3 of 3 runs parse and fit.
2. Do streamed tool calls arrive whole? `stream: true`, one tool, a prompt naming two foods. Pass: every delta that
   carries a call has the tool name and a complete JSON `arguments` string with the required field, and the stream
   ends with `finish_reason: tool_calls`.

## Thinking off (`reasoning_effort: "none"`)

| Model | Constrained JSON | Streamed tool calls whole |
| --- | --- | --- |
| gemma4:e4b | pass (3/3) | pass (2 calls, each whole) |
| qwen3.5:4b | pass (3/3) | pass (2 calls, each whole) |
| qwen3.5:9b | pass (3/3) | pass (2 calls, each whole) |

## Thinking left at the model's default (nothing sent)

| Model | Constrained JSON | Streamed tool calls whole |
| --- | --- | --- |
| gemma4:e4b | pass (3/3) | pass (2 calls, each whole) |
| qwen3.5:4b | **FAIL**: the request timed out (the client's default timeout) in two separate runs | pass (2 calls, each whole) |
| qwen3.5:9b | pass (3/3) | pass (2 calls, each whole) |

## Reading it

- Constrained JSON and whole streamed tool calls both work for all three models when thinking is off. The opencode
  report of gemma4:e4b streamed tool calls failing on this API (issue 20995, unverified) is not reproduced: one
  tool, two calls in one reply, arrived whole.
- qwen3.5:4b with thinking left on did not answer a constrained request inside the client's timeout, twice. The
  request never failed for the constraint; it was too slow. A caller of these models through this endpoint should
  send `reasoning_effort: "none"` (the evals send `think: false` natively). Whether the 4B model would finish
  given a longer timeout was not measured.
- Limits: one tool, one prompt per kind, three runs of the JSON check, temperature 0. It shows the paths work, not
  that they never fail. The AI SDK client's own handling of the stream was not exercised; the check reads the
  server's chunks directly.
