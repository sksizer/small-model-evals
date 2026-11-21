// promptfoo `javascript` assertion for the edit suite: judges an edited image.
//
// The reply (providers/mflux-edit.ts) is `{"image": "<path from the repo
// root>"}`, the edited image as a JPEG. `vars.expected` says what the edit
// must do:
//
//   expected:
//     changed: ["Is the car red?"]            # must be YES after the edit
//     kept: ["Are there two dogs?"]           # must still be YES
//     region: [0.2, 0.1, 0.8, 0.6]            # optional: [x0, y0, x1, y1] as
//                                             # fractions of the image; the only
//                                             # area the edit may change;
//                                             # [0, 0, 0, 0] allows no change
//                                             # at all (a "change nothing" control)
//
// Judge: an Ollama vision model is asked each question about the edited image
// and must answer {"answer": "yes"|"no"} (JSON schema, temperature 0, thinking
// off). `keep_alive: 0` unloads it right after the answer: the editor is a
// subprocess that has exited by then, so the two models are never in memory
// together. Set it with the assertion's `config.judge` (default qwen3.5:4b).
//
// Preservation (only with a `region`): the original and the edit are resized
// to the same size (256 x 256) and the mean absolute difference per pixel and
// channel (0-255 scale) outside the region must be at most PRESERVED_MAX.
// The editor regenerates the whole image through a VAE, so even a perfect
// local edit drifts a little everywhere; the limit sits above that drift and
// below what a changed scene does (see PRESERVED_MAX for the measurement).
// `changed` may be empty: the no-op control only asks that what was there
// stays there.
//
// Score: the mean of the changed hits, the kept hits and, when there is a
// region, preservation (1 or 0). Passes only when every changed and kept
// question is yes and preservation holds.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { parseJson, type GradingResult } from './match.ts'

const OLLAMA = process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_JUDGE = 'qwen3.5:4b'
/**
 * Largest mean absolute difference (0-255) outside the edit region that still
 * counts as preserved: 15, set from the edits FLUX.2 klein 4B q4 actually made
 * (2026-11-08, 20 cases, seed 42; the run is deterministic: the 10 cases of
 * 2026-11-02 reproduced their diffs to the hundredth).
 *
 * Basis. The preservation diffs of the edits that passed every judge question
 * (12 of the 20 edits have a region; these are the 9 that passed): 2.72, 3.12, 3.19, 4.00, 4.60, 6.30, 6.77, 7.67,
 * 11.72. Median 4.6, mean 5.6, largest 11.72 (the armchair recolour, whose
 * region covers 82% of the frame, so the outside strip is mostly its edge).
 * One of them, the 6.30, is the "change nothing" control (edit-noop-lake), the
 * editor's drift on an untouched, detailed photo; the three edits the judge
 * failed drifted 5.16, 6.78 and 9.38, inside the same range, so drift does not
 * separate good edits from bad ones: the limit is only there to catch an edit
 * that rewrote the scene.
 * Ceiling. Whole-image changes on one photo (2026-11-02, oi-objects-25d107f1...,
 * region-less): a 5% crop shift 20.7, a 40% darkening 36.4, a hue rotation
 * 35.1, greyscale 27.8, a different photo 81.9; JPEG re-encoding alone 0.7.
 * Rule. The largest passing diff plus a quarter (11.72 x 1.25 = 14.65), rounded
 * up to 15, which must stay under three quarters of the smallest whole-image
 * change (0.75 x 20.7 = 15.5): it does. The previous hand-set 12 had under 3%
 * of room above the armchair; no outcome changed when it moved to 15 (no failed
 * case lies between 12 and 15). Re-derive it when the edit set grows: the rule
 * is the largest passing diff x 1.25, never above 0.75 x 20.7.
 */
export const PRESERVED_MAX = 15
const COMPARE_SIZE = 256

export type Region = [number, number, number, number]

export interface ExpectedEdit {
  changed: string[]
  kept: string[]
  region?: Region
}

export interface Judged {
  question: string
  /** `changed` or `kept`. */
  kind: 'changed' | 'kept'
  answer: 'yes' | 'no' | null
  ok: boolean
}

export interface Preservation {
  /** Mean absolute difference outside the region, 0-255. */
  diff: number
  max: number
  ok: boolean
}

export interface EditGrading extends GradingResult {
  /** What the judge said, for the site (scripts/ledger.ts keeps it as `detail`). */
  metadata: { judge: string; answers: Judged[]; preservation: Preservation | null }
}

/** The edited image's path in a reply, or null. */
export function parseEdit(output: unknown): string | null {
  const got = parseJson(output) as { image?: unknown } | undefined
  return got && typeof got.image === 'string' ? got.image : null
}

/** Asks the judge one yes/no question about an image; null when it did not answer. */
export async function ask(judge: string, image: Buffer, question: string): Promise<'yes' | 'no' | null> {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    body: JSON.stringify({
      model: judge,
      stream: false,
      think: false,
      keep_alive: 0,
      options: { temperature: 0, num_ctx: 4096, num_predict: 32 },
      format: { type: 'object', required: ['answer'], properties: { answer: { type: 'string', enum: ['yes', 'no'] } } },
      messages: [
        {
          role: 'user',
          content: `Look at the image and answer the question about it with yes or no. Question: ${question}`,
          images: [image.toString('base64')],
        },
      ],
    }),
  })
  if (!res.ok) throw new Error(`judge /api/chat: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { message: { content: string } }
  const answer = (parseJson(body.message.content) as { answer?: unknown } | undefined)?.answer
  return answer === 'yes' || answer === 'no' ? answer : null
}

/** Mean absolute per-pixel, per-channel difference outside `region`, on a common 256 x 256 grid. */
export async function outsideDiff(original: Buffer, edited: Buffer, region: Region): Promise<number> {
  const grid = async (b: Buffer) => sharp(b).removeAlpha().resize(COMPARE_SIZE, COMPARE_SIZE, { fit: 'fill' }).raw().toBuffer()
  const [a, e] = await Promise.all([grid(original), grid(edited)])
  const [x0, y0, x1, y1] = region.map((f) => f * COMPARE_SIZE) as Region
  let sum = 0
  let n = 0
  for (let y = 0; y < COMPARE_SIZE; y++) {
    for (let x = 0; x < COMPARE_SIZE; x++) {
      if (x + 0.5 >= x0 && x + 0.5 <= x1 && y + 0.5 >= y0 && y + 0.5 <= y1) continue
      for (let c = 0; c < 3; c++) {
        const i = (y * COMPARE_SIZE + x) * 3 + c
        sum += Math.abs(a[i]! - e[i]!)
      }
      n += 3
    }
  }
  return n === 0 ? 0 : sum / n
}

/** The image of a promptfoo var (a data URL or bare base64). */
const bytesOf = (v: string) => Buffer.from(v.replace(/^data:image\/[a-z]+;base64,/, ''), 'base64')

export async function gradeEdit(expected: ExpectedEdit, output: unknown, original: Buffer, judge = DEFAULT_JUDGE): Promise<EditGrading> {
  const empty = { judge, answers: [], preservation: null }
  const path = parseEdit(output)
  if (!path) return { pass: false, score: 0, reason: 'reply has no image path', metadata: empty }
  let edited: Buffer
  try {
    edited = readFileSync(join(ROOT, path))
  } catch {
    return { pass: false, score: 0, reason: `edited image ${path} is missing`, metadata: empty }
  }
  const answers: Judged[] = []
  for (const [kind, questions] of [['changed', expected.changed], ['kept', expected.kept]] as const) {
    for (const question of questions) {
      const answer = await ask(judge, edited, question)
      answers.push({ question, kind, answer, ok: answer === 'yes' })
    }
  }
  let preservation: Preservation | null = null
  if (expected.region) {
    const diff = await outsideDiff(original, edited, expected.region)
    preservation = { diff: Math.round(diff * 100) / 100, max: PRESERVED_MAX, ok: diff <= PRESERVED_MAX }
  }
  const parts = [...answers.map((a) => (a.ok ? 1 : 0)), ...(preservation ? [preservation.ok ? 1 : 0] : [])]
  const score = parts.reduce<number>((s, x) => s + x, 0) / parts.length
  const failed = answers.filter((a) => !a.ok)
  const notes = [
    `${answers.filter((a) => a.kind === 'changed' && a.ok).length}/${expected.changed.length} changed, ${answers.filter((a) => a.kind === 'kept' && a.ok).length}/${expected.kept.length} kept`,
    ...(preservation ? [`outside the region the image differs by ${preservation.diff} of 255 (limit ${PRESERVED_MAX})${preservation.ok ? '' : ': not preserved'}`] : []),
    ...failed.map((a) => `${a.kind} not met: ${a.question} (${a.answer ?? 'no answer'})`),
  ]
  return { pass: failed.length === 0 && (preservation?.ok ?? true), score, reason: notes.join('; '), metadata: { judge, answers, preservation } }
}

export default async function (output: unknown, context: { vars: { image: string; expected: ExpectedEdit }; config?: { judge?: string } }): Promise<EditGrading> {
  return gradeEdit(context.vars.expected, output, bytesOf(context.vars.image), context.config?.judge)
}
