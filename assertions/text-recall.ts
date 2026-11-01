// promptfoo `javascript` assertion for the ocr suite: the share of
// `vars.expected` strings that appear in the reply, case-insensitive.
// Passes at 75%.
import type { GradingResult } from './match.ts'

const PASS_AT = 0.75

export default function (output: unknown, context: { vars: { expected: string[] } }): GradingResult {
  const text = typeof output === 'string' ? output.toLowerCase() : ''
  const missing = context.vars.expected.filter((s) => !text.includes(s.toLowerCase()))
  const score = 1 - missing.length / context.vars.expected.length
  return {
    pass: score >= PASS_AT,
    score,
    reason: missing.length === 0 ? 'read every expected string' : `missed: ${missing.join(' | ')}`,
  }
}
