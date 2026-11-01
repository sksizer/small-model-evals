// Shared matchers for the suites' expected values. A test writes the value it
// expects for each field; this decides whether the model's value counts.

/** One expected value: a literal, a list of acceptable literals, or a matcher. */
export type Expected =
  | string
  | number
  | null
  | Expected[]
  | { contains: string }
  | { startsWith: string }
  | { approx: number; tol: number }

export function matches(expected: Expected, actual: unknown): boolean {
  if (Array.isArray(expected)) return expected.some((e) => matches(e, actual))
  if (expected === null) return actual === null || actual === undefined || actual === ''
  if (typeof expected === 'number') return typeof actual === 'number' && actual === expected
  if (typeof expected === 'string') {
    return typeof actual === 'string' && actual.trim().toLowerCase() === expected.toLowerCase()
  }
  if ('contains' in expected) {
    return typeof actual === 'string' && actual.toLowerCase().includes(expected.contains.toLowerCase())
  }
  if ('startsWith' in expected) {
    return typeof actual === 'string' && actual.startsWith(expected.startsWith)
  }
  return typeof actual === 'number' && Math.abs(actual - expected.approx) <= expected.tol
}

/** Parses a model's JSON reply, tolerating a ```json fence around it. */
export function parseJson(output: unknown): unknown {
  if (typeof output !== 'string') return output
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(output)
  try {
    return JSON.parse(fenced ? fenced[1]! : output)
  } catch {
    return undefined
  }
}

export interface GradingResult {
  pass: boolean
  score: number
  reason: string
}

/** Scores an object field by field: the share of expected fields that match. */
export function gradeFields(expected: Record<string, Expected>, actual: unknown): GradingResult {
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
    return { pass: false, score: 0, reason: 'reply is not a JSON object' }
  }
  const got = actual as Record<string, unknown>
  const misses = Object.entries(expected)
    .filter(([key, want]) => !matches(want, got[key]))
    .map(([key, want]) => `${key}: wanted ${JSON.stringify(want)}, got ${JSON.stringify(got[key])}`)
  const total = Object.keys(expected).length
  const score = total === 0 ? 1 : (total - misses.length) / total
  return {
    pass: misses.length === 0,
    score,
    reason: misses.length === 0 ? 'all fields match' : misses.join('; '),
  }
}
