// promptfoo `javascript` assertion for the workout suite, and the per-item
// comparison the results site shows.
//
// The reply is a session: `date`, `activity`, `duration_min` and a list of
// `exercises`, each with `name`, `sets` (one object per set: reps, weight_kg,
// seconds), `duration_min` and `distance_km`. `vars.expected` gives the
// session fields to check and the exercises the log describes:
//
//   expected:
//     date: '2026-10-29'
//     activity: [strength, mixed]        # any match.ts matcher
//     exercises:
//       - { name: [bench press, bench], sets: '4x8@60' }
//       - { name: run, distance_km: { approx: 6.44, tol: 0.05 }, duration_min: 38.5 }
//
// `sets` is shorthand, comma-separated: `3x5@100` (three sets of 5 at 100 kg),
// `5@100` (one set), `3x10` (bodyweight), `3x30s` (timed), `10@12|24` (either
// weight). Weights match within 1% or 0.6 kg, which absorbs lb conversions.
// An exercise's name matches like a tag (assertions/tags.ts): a synonym's
// words appear in the model's name. Fields an expected exercise leaves out
// are not checked, except `sets`: left out, the model must give none.
//
// Score: each checked session field is one item, each expected exercise one
// item scored by the share of its checked fields that match (sets by the
// share of set positions that match), and each exercise the model adds that
// the log does not describe is one failed item. Passes at 0.85, so a
// missing exercise fails a case and a single wrong set does not.
import { matches, parseJson, type Expected, type GradingResult } from './match.ts'
import { tagMatches, type Concept } from './tags.ts'

const PASS_AT = 0.85

export interface ExpectedExercise {
  name: Concept
  sets?: string
  duration_min?: Expected
  distance_km?: Expected
}

export interface ExpectedWorkout {
  date?: Expected
  activity?: Expected
  duration_min?: Expected
  exercises: ExpectedExercise[]
}

interface Set {
  reps: number | null
  weight_kg: number | null
  seconds: number | null
}
interface Exercise {
  name: string
  sets: Set[]
  duration_min: number | null
  distance_km: number | null
}

/** One expected set: reps or seconds, and the acceptable weights (none for bodyweight). */
interface WantSet {
  reps: number | null
  seconds: number | null
  weights: number[]
}

/** Expands set shorthand such as `3x5@100, 1x3@110` into one entry per set. */
export function parseSets(shorthand: string): WantSet[] {
  const out: WantSet[] = []
  for (const part of shorthand.split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = /^(?:(\d+)\s*x\s*)?(\d+(?:\.\d+)?)(s?)(?:\s*@\s*([\d.|]+))?$/i.exec(part)
    if (!m) throw new Error(`bad set shorthand: ${part}`)
    const count = m[1] ? Number(m[1]) : 1
    const n = Number(m[2])
    const timed = m[3] === 's'
    const weights = m[4] ? m[4].split('|').map(Number) : []
    for (let i = 0; i < count; i++) out.push({ reps: timed ? null : n, seconds: timed ? n : null, weights })
  }
  return out
}

const weightOk = (want: number[], got: unknown) =>
  want.length === 0
    ? got === null || got === undefined || got === 0
    : typeof got === 'number' && want.some((w) => Math.abs(got - w) <= Math.max(0.6, w * 0.01))

function setOk(want: WantSet, got: Partial<Set> | undefined): boolean {
  if (!got) return false
  if (want.seconds !== null) return typeof got.seconds === 'number' && Math.abs(got.seconds - want.seconds) <= 1
  return got.reps === want.reps && weightOk(want.weights, got.weight_kg)
}

/** Sets in the shorthand the cases use, for reading a reply beside the expectation. */
export function showSets(sets: Partial<Set>[] | undefined): string {
  if (!sets || sets.length === 0) return 'none'
  const one = (s: Partial<Set>) =>
    typeof s.seconds === 'number' && s.reps == null
      ? `${s.seconds}s`
      : `${s.reps ?? '?'}${typeof s.weight_kg === 'number' && s.weight_kg !== 0 ? `@${Math.round(s.weight_kg * 10) / 10}` : ''}`
  const parts: string[] = []
  for (const s of sets.map(one)) {
    const last = parts.at(-1)
    const m = last ? /^(\d+)x(.+)$/.exec(last) : null
    if (m && m[2] === s) parts[parts.length - 1] = `${Number(m[1]) + 1}x${s}`
    else parts.push(`1x${s}`)
  }
  return parts.map((p) => p.replace(/^1x/, '')).join(', ')
}

export interface Row {
  field: string
  want: unknown
  got: unknown
  ok: boolean
  /** For an exercise: the share of its checked fields that match. */
  score: number
}

/** Compares a reply with the expectation, one row per checked item. */
export function compareWorkout(expected: ExpectedWorkout, output: unknown): Row[] | null {
  const got = parseJson(output)
  if (!got || typeof got !== 'object' || Array.isArray(got)) return null
  const session = got as Partial<Record<'date' | 'activity' | 'duration_min', unknown>> & { exercises?: unknown }
  const rows: Row[] = []
  for (const key of ['date', 'activity', 'duration_min'] as const) {
    if (!(key in expected)) continue
    const ok = matches(expected[key]!, session[key])
    rows.push({ field: key, want: expected[key], got: session[key] ?? null, ok, score: ok ? 1 : 0 })
  }
  const exercises = (Array.isArray(session.exercises) ? session.exercises : []) as Partial<Exercise>[]
  const used = new Set<number>()
  for (const want of expected.exercises) {
    const label = Array.isArray(want.name) ? want.name[0]! : want.name
    const i = exercises.findIndex((e, j) => !used.has(j) && typeof e.name === 'string' && tagMatches(want.name, [e.name]))
    if (i < 0) {
      rows.push({ field: `exercise: ${label}`, want: describe(want), got: null, ok: false, score: 0 })
      continue
    }
    used.add(i)
    const e = exercises[i]!
    const checks: number[] = []
    const wantSets = parseSets(want.sets ?? '')
    const gotSets = Array.isArray(e.sets) ? e.sets : []
    const hits = wantSets.filter((w, k) => setOk(w, gotSets[k])).length
    const longest = Math.max(wantSets.length, gotSets.length)
    checks.push(longest === 0 ? 1 : hits / longest)
    if ('duration_min' in want) checks.push(matches(want.duration_min!, e.duration_min) ? 1 : 0)
    if ('distance_km' in want) checks.push(matches(want.distance_km!, e.distance_km) ? 1 : 0)
    const score = checks.reduce((a, b) => a + b, 0) / checks.length
    rows.push({ field: `exercise: ${label}`, want: describe(want), got: describe(e), ok: score === 1, score })
  }
  exercises.forEach((e, j) => {
    if (!used.has(j)) rows.push({ field: `extra: ${String(e.name)}`, want: null, got: describe(e), ok: false, score: 0 })
  })
  return rows
}

/** One line for an exercise, expected or given. */
function describe(e: Partial<ExpectedExercise> | Partial<Exercise>): string {
  const sets = typeof e.sets === 'string' ? e.sets : Array.isArray(e.sets) ? showSets(e.sets) : ''
  const name = Array.isArray(e.name) ? e.name.join(' / ') : String(e.name)
  const parts = [name, sets && sets !== 'none' ? sets : '']
  if (e.duration_min != null) parts.push(`${typeof e.duration_min === 'number' ? e.duration_min : JSON.stringify(e.duration_min)} min`)
  if (e.distance_km != null) parts.push(`${typeof e.distance_km === 'number' ? e.distance_km : JSON.stringify(e.distance_km)} km`)
  return parts.filter(Boolean).join(' · ')
}

export function gradeWorkout(expected: ExpectedWorkout, output: unknown): GradingResult {
  const rows = compareWorkout(expected, output)
  if (!rows) return { pass: false, score: 0, reason: 'reply is not a JSON object' }
  const score = rows.length === 0 ? 1 : rows.reduce((a, r) => a + r.score, 0) / rows.length
  const misses = rows.filter((r) => !r.ok).map((r) => `${r.field}: wanted ${JSON.stringify(r.want)}, got ${JSON.stringify(r.got)}`)
  return { pass: score >= PASS_AT, score, reason: misses.length === 0 ? 'every item matches' : misses.join('; ') }
}

export default function (output: unknown, context: { vars: { expected: ExpectedWorkout } }): GradingResult {
  return gradeWorkout(context.vars.expected, output)
}
