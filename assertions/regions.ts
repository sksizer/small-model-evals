// promptfoo `javascript` assertion for the regions suite, and the box-by-box
// comparison the results site draws.
//
// The reply (providers/region-detector.ts, or a vision model asked for JSON)
// is `{"boxes": [{"label": "...", "score": 0.9, "box": [x0, y0, x1, y1]}]}`,
// with coordinates as fractions of the image's width and height (0 to 1,
// top left origin). `vars.expected.boxes` lists every region the case asks
// about, in the same coordinates:
//
//   expected:
//     labels: [laptop, pen, [cup, mug]]   # optional; defaults to the boxes' labels
//     boxes:
//       - { label: [laptop, computer], box: [0.10, 0.32, 0.55, 0.80] }
//       - { label: pen, box: [0.61, 0.70, 0.74, 0.76] }
//
// The ground truth is exhaustive for the labels in scope: `labels` plus every
// box's label. A predicted box counts only when its label matches one of them
// (a synonym's words appear in the predicted label, see assertions/names.ts);
// a detector's boxes for other things ("chair" on a case about laptops) are
// ignored rather than counted wrong. `labels` is how a case says "there is
// no face here": `labels: [face]` with no boxes makes any face box wrong.
//
// Matching is greedy by overlap: the pair (expected, predicted) with the
// highest IoU, labels matching, is matched first, down to IoU 0.5. Unmatched
// expected boxes are misses; unmatched in-scope predictions are false
// positives. Score: F1 of precision and recall (1 when the case expects no
// boxes and none are given). Passes at 0.7.
import { parseJson, type GradingResult } from './match.ts'
import type { Concept } from './tags.ts'
import { nameMatches } from './names.ts'

const PASS_AT = 0.7
const IOU_MIN = 0.5

export type Box = [number, number, number, number]

export interface ExpectedRegion {
  label: Concept
  box: Box
}

export interface PredictedRegion {
  label: string
  score?: number
  box: Box
}

export interface RegionMatch {
  /** The expected label (first synonym), or the predicted label for a false positive. */
  label: string
  want: Box | null
  got: Box | null
  iou: number | null
  ok: boolean
}

export function iou(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
  const inter = ix * iy
  const area = (r: Box) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1])
  const union = area(a) + area(b) - inter
  return union <= 0 ? 0 : inter / union
}

const isBox = (b: unknown): b is Box => Array.isArray(b) && b.length === 4 && b.every((n) => typeof n === 'number' && Number.isFinite(n))

/** The boxes in a reply, or null when it has no `boxes` list. */
export function parseBoxes(output: unknown): PredictedRegion[] | null {
  const got = parseJson(output) as { boxes?: unknown } | undefined
  if (!got || !Array.isArray(got.boxes)) return null
  return got.boxes
    .filter((b): b is PredictedRegion => !!b && typeof b === 'object' && typeof (b as PredictedRegion).label === 'string' && isBox((b as PredictedRegion).box))
    .map((b) => ({ ...b, box: [...b.box].map((n) => Math.min(1, Math.max(0, n))) as Box }))
}

const first = (c: Concept) => (Array.isArray(c) ? c[0]! : c)

/** Expected and in-scope predicted boxes, paired; null when the reply has no boxes list. */
export function compareRegions(expected: ExpectedRegion[], output: unknown, labels: Concept[] = []): RegionMatch[] | null {
  const predicted = parseBoxes(output)
  if (!predicted) return null
  const scope = [...labels, ...expected.map((e) => e.label)]
  const inScope = predicted.filter((p) => scope.some((l) => nameMatches(l, p.label)))
  const pairs: { e: number; p: number; iou: number }[] = []
  expected.forEach((e, ei) =>
    inScope.forEach((p, pi) => {
      if (!nameMatches(e.label, p.label)) return
      const v = iou(e.box, p.box)
      if (v >= IOU_MIN) pairs.push({ e: ei, p: pi, iou: v })
    }),
  )
  pairs.sort((a, b) => b.iou - a.iou)
  const eUsed = new Map<number, { p: number; iou: number }>()
  const pUsed = new Set<number>()
  for (const pair of pairs) {
    if (eUsed.has(pair.e) || pUsed.has(pair.p)) continue
    eUsed.set(pair.e, { p: pair.p, iou: pair.iou })
    pUsed.add(pair.p)
  }
  const rows: RegionMatch[] = expected.map((e, ei) => {
    const m = eUsed.get(ei)
    return { label: first(e.label), want: e.box, got: m ? inScope[m.p]!.box : null, iou: m ? m.iou : null, ok: !!m }
  })
  inScope.forEach((p, pi) => {
    if (!pUsed.has(pi)) rows.push({ label: p.label, want: null, got: p.box, iou: null, ok: false })
  })
  return rows
}

export function gradeRegions(expected: ExpectedRegion[], output: unknown, labels: Concept[] = []): GradingResult {
  const rows = compareRegions(expected, output, labels)
  if (!rows) return { pass: false, score: 0, reason: 'reply has no boxes list' }
  const hits = rows.filter((r) => r.ok).length
  const misses = rows.filter((r) => r.want && !r.ok)
  const extra = rows.filter((r) => !r.want)
  const predictedN = hits + extra.length
  const precision = predictedN === 0 ? (expected.length === 0 ? 1 : 0) : hits / predictedN
  const recall = expected.length === 0 ? (predictedN === 0 ? 1 : 0) : hits / expected.length
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
  const notes = [
    `${hits}/${expected.length} found, ${extra.length} extra (precision ${precision.toFixed(2)}, recall ${recall.toFixed(2)})`,
    ...(misses.length > 0 ? [`missed: ${misses.map((m) => m.label).join(', ')}`] : []),
    ...(extra.length > 0 ? [`extra: ${extra.map((m) => m.label).join(', ')}`] : []),
  ]
  return { pass: f1 >= PASS_AT, score: f1, reason: notes.join('; ') }
}

export interface ExpectedRegions {
  labels?: Concept[]
  boxes: ExpectedRegion[]
}

export default function (output: unknown, context: { vars: { expected: ExpectedRegions } }): GradingResult {
  return gradeRegions(context.vars.expected.boxes, output, context.vars.expected.labels)
}
