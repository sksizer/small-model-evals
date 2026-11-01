// promptfoo `javascript` assertion for JSON replies: every field in
// `vars.expected` must match (see match.ts for the matcher forms).
import { gradeFields, parseJson, type Expected, type GradingResult } from './match.ts'

export default function (output: unknown, context: { vars: { expected: Record<string, Expected> } }): GradingResult {
  return gradeFields(context.vars.expected, parseJson(output))
}
