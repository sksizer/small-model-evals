// promptfoo `javascript` assertion for decision suites (route): each named
// question's answer must equal `vars.expected[question]`, or be one of a list
// when several answers are right. Score: the share of questions answered
// right. Passes when every question is.
//
// For decision models, which return probabilities, the reason also gives the
// probability placed on the right answer, so a near miss reads differently
// from a confident wrong one.
import { parseJson, type GradingResult } from './match.ts'

interface Reply {
  answers?: Record<string, { value?: unknown; p?: Record<string, number> }>
}

export interface DecideRow {
  field: string
  want: string
  got: string
  ok: boolean
}

export function compareDecide(expected: Record<string, string | string[]>, output: unknown): DecideRow[] | null {
  const reply = parseJson(output) as Reply | undefined
  if (!reply?.answers) return null
  return Object.entries(expected).map(([q, want]) => {
    const wants = Array.isArray(want) ? want : [want]
    const a = reply.answers![q]
    const got = a?.value === undefined ? 'no answer' : String(a.value)
    const pRight = a?.p ? wants.reduce((s, w) => s + (a.p![w] ?? 0), 0) : null
    return {
      field: q,
      want: wants.join(' | '),
      got: pRight === null ? got : `${got} (p right ${pRight.toFixed(2)})`,
      ok: wants.includes(got),
    }
  })
}

export default function (output: unknown, context: { vars: { expected: Record<string, string | string[]> } }): GradingResult {
  const rows = compareDecide(context.vars.expected, output)
  if (!rows) return { pass: false, score: 0, reason: 'reply has no answers' }
  const right = rows.filter((r) => r.ok).length
  return {
    pass: right === rows.length,
    score: right / rows.length,
    reason: rows.map((r) => `${r.field}: ${r.ok ? 'ok' : `wanted ${r.want}`}, got ${r.got}`).join('; '),
  }
}
