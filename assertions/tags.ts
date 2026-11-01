// promptfoo `javascript` assertion for the tag-image suite, and the matcher
// the results site uses to show which tags a model found.
//
// The reply is JSON `{"tags": [...]}`. `vars.expected` lists the concepts
// the image plainly shows; each is one tag or a list of synonyms, any of
// which counts. A model tag matches a synonym when the synonym's words
// appear in order inside the tag, after lower-casing and dropping a plural
// `s`, so "sleeping dogs" matches "dog". `vars.absent` lists tags that would
// be wrong for the image (a plausible hallucination); each one the model
// gives costs a quarter point and fails the case.
//
// Passes when at least 60% of the expected concepts are found and no absent
// tag is given.
import { parseJson, type GradingResult } from './match.ts'

const PASS_AT = 0.6
const ABSENT_COST = 0.25

export type Concept = string | string[]

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))

function containsRun(hay: string[], needle: string[]): boolean {
  if (needle.length === 0) return false
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((w, j) => hay[i + j] === w)) return true
  }
  return false
}

/** The tags in a reply, or null when it is not `{"tags": [...]}` or a list. */
export function parseTags(output: unknown): string[] | null {
  const got = parseJson(output)
  const list = Array.isArray(got) ? got : got && typeof got === 'object' ? (got as { tags?: unknown }).tags : null
  return Array.isArray(list) ? list.filter((t): t is string => typeof t === 'string') : null
}

/** Whether any tag matches any synonym of the concept. */
export function tagMatches(concept: Concept, tags: string[]): boolean {
  const synonyms = (Array.isArray(concept) ? concept : [concept]).map(words)
  return tags.some((t) => {
    const w = words(t)
    return synonyms.some((s) => containsRun(w, s))
  })
}

/** How a concept reads on the site: its synonyms joined with a slash. */
export const conceptLabel = (c: Concept) => (Array.isArray(c) ? c.join(' / ') : c)

export function gradeTags(expected: Concept[], absent: string[], output: unknown): GradingResult {
  const tags = parseTags(output)
  if (!tags) return { pass: false, score: 0, reason: 'reply is not {"tags": [...]}' }
  const missed = expected.filter((c) => !tagMatches(c, tags))
  const wrong = absent.filter((a) => tagMatches(a, tags))
  const recall = 1 - missed.length / expected.length
  const score = Math.max(0, recall - ABSENT_COST * wrong.length)
  const notes = [
    missed.length > 0 ? `missed: ${missed.map(conceptLabel).join(' | ')}` : 'found every expected tag',
    ...(wrong.length > 0 ? [`wrong: ${wrong.join(' | ')}`] : []),
  ]
  return { pass: recall >= PASS_AT && wrong.length === 0, score, reason: notes.join('; ') }
}

export default function (
  output: unknown,
  context: { vars: { expected: Concept[]; absent?: string[] } },
): GradingResult {
  return gradeTags(context.vars.expected, context.vars.absent ?? [], output)
}
