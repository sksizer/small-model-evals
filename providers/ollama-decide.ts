// promptfoo custom provider for decision suites (route): poses named
// questions about an input and returns one answer per question.
//
// Two backends, so decision models and chat models share a leaderboard:
//
// - `decision: true` — Ollama's decision endpoint (/v1/systemone) for models
//   such as Liquid's d1. They generate no text: every option is scored in
//   one forward pass and each answer comes with probabilities.
// - otherwise — /api/chat, one call per question, the reply constrained to
//   the question's options by a JSON schema. No probabilities.
//
// Questions come from `vars.questions` (usually set once in defaultTest):
//   { handler: { type: choice, instructions: "...", criteria: { name: description } },
//     large:   { type: noul, instructions: "..." },          # yes / no
//     effort:  { type: score, instructions: "...", levels: ["low", ...] } }
// The input is `vars.input` (text) and optionally `vars.image`.
//
// Output is JSON: {"answers": {"<question>": {"value": "...", "p": {option: prob}}}}.
// A noul answer's value is "yes" or "no".

const BASE = process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434'

interface Question {
  type: 'choice' | 'noul' | 'score'
  instructions: string
  criteria?: Record<string, string | null>
  levels?: string[]
}

interface Config {
  model: string
  decision?: boolean
  think?: boolean
  num_ctx?: number
}

interface Answer {
  value: string
  p?: Record<string, number>
}

const options = (q: Question): string[] =>
  q.type === 'choice' ? Object.keys(q.criteria ?? {}) : q.type === 'noul' ? ['yes', 'no'] : (q.levels ?? []).map(String)

const stripDataUrl = (s: string) => s.replace(/^data:image\/[a-z]+;base64,/, '')

export default class OllamaDecide {
  private readonly config: Config

  constructor(options: { config: Config }) {
    this.config = options.config
  }

  id(): string {
    return `ollama-decide:${this.config.model}`
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${BASE}${path}`, { method: 'POST', body: JSON.stringify(body) })
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
    return res.json()
  }

  private async viaDecision(input: string, image: string | undefined, questions: Record<string, Question>) {
    const res = (await this.post('/v1/systemone', {
      model: this.config.model,
      state: input,
      ...(image ? { images: [stripDataUrl(image)] } : {}),
      questions: Object.fromEntries(
        Object.entries(questions).map(([id, q]) => [
          id,
          q.type === 'score'
            ? { type: 'score', instructions: q.instructions, levels: q.levels }
            : { type: q.type, instructions: q.instructions, ...(q.criteria ? { criteria: q.criteria } : {}) },
        ]),
      ),
    })) as { answers: Record<string, { choice?: string; noul?: number; score?: number; probabilities?: Record<string, number> }> }
    const answers: Record<string, Answer> = {}
    for (const [id, q] of Object.entries(questions)) {
      const a = res.answers[id]
      if (!a) continue
      if (q.type === 'noul') answers[id] = { value: (a.noul ?? 0) >= 0.5 ? 'yes' : 'no', p: { yes: a.noul ?? 0, no: 1 - (a.noul ?? 0) } }
      else if (q.type === 'choice') answers[id] = { value: String(a.choice), ...(a.probabilities ? { p: a.probabilities } : {}) }
      else {
        // A score answer is probability-weighted; its value is the likeliest level.
        const p = a.probabilities ?? {}
        const best = Object.entries(p).sort((x, y) => y[1] - x[1])[0]?.[0] ?? String(Math.round(a.score ?? 0))
        answers[id] = { value: (q.levels ?? [])[Number(best)] ?? best, p }
      }
    }
    return answers
  }

  private async viaChat(input: string, image: string | undefined, questions: Record<string, Question>) {
    const answers: Record<string, Answer> = {}
    for (const [id, q] of Object.entries(questions)) {
      const opts = options(q)
      const described =
        q.type === 'choice'
          ? Object.entries(q.criteria ?? {}).map(([k, v]) => `- ${k}${v ? `: ${v}` : ''}`).join('\n')
          : opts.map((o) => `- ${o}`).join('\n')
      const res = (await this.post('/api/chat', {
        model: this.config.model,
        stream: false,
        ...(this.config.think === undefined ? {} : { think: this.config.think }),
        // The answer is one short JSON field; the cap stops a runaway reply.
        options: { temperature: 0, num_ctx: this.config.num_ctx ?? 4096, num_predict: 64 },
        format: { type: 'object', required: ['answer'], properties: { answer: { type: 'string', enum: opts } } },
        messages: [
          { role: 'system', content: `${q.instructions}\nAnswer with one of:\n${described}\nReply as JSON: {"answer": "<option>"}.` },
          { role: 'user', content: input, ...(image ? { images: [stripDataUrl(image)] } : {}) },
        ],
      })) as { message: { content: string } }
      try {
        answers[id] = { value: String((JSON.parse(res.message.content) as { answer: unknown }).answer) }
      } catch {
        answers[id] = { value: res.message.content }
      }
    }
    return answers
  }

  async callApi(_prompt: string, context: { vars: { input?: string; image?: string; questions: Record<string, Question> } }) {
    try {
      const { input = '', image, questions } = context.vars
      const answers = this.config.decision ? await this.viaDecision(input, image, questions) : await this.viaChat(input, image, questions)
      return { output: JSON.stringify({ answers }) }
    } catch (err) {
      return { error: String(err) }
    }
  }
}
