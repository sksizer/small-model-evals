// promptfoo custom provider for the sensitive suite: what an app would ship.
// Cheap specialists first, the vision LLM only when none of them is decisive.
//
// Stages, in order (each one's time goes in the output's `stages`):
//   1. yunet   (providers/onnx-detector.ts)  faces: how many, and how much of the image the largest fills.
//   2. nsfw    (providers/image-classifier.ts, Falconsai ViT)  p(nsfw).
//   3. siglip  (providers/zero-shot.ts)  a risk per category.
//   4. ocr     (providers/florence2.ts)  every line of text, then the regexes below. Runs on every
//              image: text is the one thing the other specialists cannot rule out, and OCR (about 1-2 s)
//              costs far less than the LLM.
//   5. llm     (providers/ollama-sensitive.ts)  the full category rating. Runs only when not decisive.
//
// Strong evidence (risk 0.9 for the category), each rule fixed up front:
//   face        the largest YuNet face covers >= 4% of the image and there are at most 2 faces
//               (a portrait; crowds and distant figures do not count, as in the corpus rules)
//   nudity      p(nsfw) >= 0.9
//   id-document an MRZ line, "passport", "licence/license", "identity card", "date of birth"/"DOB"
//   financial   13-19 digits (spaces or dashes allowed), an IBAN, or "invoice", "bank statement", "account number"
//   credential  "password", "passcode", "verification code", "api key"
//   medical     "prescription", "patient", "diagnosis", "dosage", "lab result"
//   screen      an email address or phone number while siglip's screen risk >= 0.3
//   document    an email address or phone number otherwise, or "dear ..."/"sincerely"/"agreement"
//
// "Decisive", defined simply:
//   - private: strong evidence for a private category (nudity, id-document, financial, credential).
//     `private` is the top level, so nothing the LLM could say changes the level.
//   - public: only with positive evidence that the image is ordinary, never from the silence of the
//     specialists. ALL of these must hold:
//       * no strong evidence for any category;
//       * OCR found no text (a line with two or more letters or digits): text can carry any
//         text-bearing category, and a zero-shot model that scores "quiet" on a letter, a label or
//         a plate says nothing about what the words reveal, so any text goes to the LLM;
//       * no face at all, and p(nsfw) < 0.1: any person-bearing signal, however weak, goes to the LLM
//         (the face detector misses faces in small, turned-away or partly covered figures, and the
//         categories intimate, minor and nudity are about bodies, not only faces);
//       * SigLIP positively recognises an ordinary scene: its best generic-negative prompt scores
//         >= 0.5 (the sigmoid's own midpoint, the same cut as for a category) AND above every
//         category's risk. SigLIP scoring every category low is not enough: its sigmoid scores are
//         low for most images, sensitive ones included, so silence is not evidence.
//   Anything else goes to the LLM.
// The result: categories = strong evidence, max'd with the LLM's risks when it ran; when it did
// not, siglip risks >= 0.5 are added too (a decisive-public image has none).
//
// Config: `yunet`, `nsfw`, `siglip`, `ocr` (each the config of that provider), `llm` (Ollama
// config as in providers/ollama-sensitive.ts). Vars: `image`.
// Output: {"categories", "level", "stages": {name: ms}, "decided_by": "rules" | "public-signals" | "llm", "ordinary" (SigLIP's score for an ordinary scene), "ocr_lines" (count)}.
// Metadata: classify_ms (everything except loading), load_ms (first case), rss_mb, loaded_bytes
// (the LLM's size in memory, when it ran), ran_ocr / ran_llm (0 or 1), yunet_ms, nsfw_ms,
// siglip_ms, ocr_ms, llm_ms (when the stage ran).
import { CATEGORIES, PRIVATE_CATEGORIES, levelFromRisks, type Category } from '../assertions/sensitive-levels.ts'
import { flagScore, type Config as ClassifierConfig } from './image-classifier.ts'
import Florence2 from './florence2.ts'
import { detect, type Config as DetectorConfig } from './onnx-detector.ts'
import { rate } from './ollama-sensitive.ts'
import { zeroShotRisks, type ZeroShotConfig } from './zero-shot.ts'
import { imageOf } from './region-detector.ts'

interface Config {
  yunet: DetectorConfig
  nsfw: ClassifierConfig
  siglip: ZeroShotConfig
  ocr: ConstructorParameters<typeof Florence2>[0]['config']
  llm: { model: string; think?: boolean; num_ctx?: number }
}

const STRONG = 0.9
const ORDINARY_MIN = 0.5

/** Text rules over the OCR lines joined with spaces: the categories the text is strong evidence for. */
export function textEvidence(lines: string[], screenRisk: number): Category[] {
  const text = lines.join(' ')
  const found = new Set<Category>()
  // A card number or IBAN is financial, and is not also read as a phone number below.
  const numeric = /\b(?:\d[ -]?){13,19}\b/.test(text) || /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,4})?\b/.test(text)
  if (numeric || /\b(?:invoice|bank statement|account number)\b/i.test(text)) found.add('financial')
  if (/[A-Z0-9<]{9,}<<[A-Z0-9<]*/.test(text) || /\b(?:passport|licen[cs]e|identity card|id card|date of birth|dob)\b/i.test(text)) found.add('id-document')
  if (/\b(?:password|passcode|verification code|api key)\b/i.test(text)) found.add('credential')
  if (/\b(?:prescription|patient|diagnosis|dosage|lab result)s?\b/i.test(text)) found.add('medical')
  const contact = /[\w.+-]+@[\w-]+\.[\w.-]+/.test(text) || (!numeric && /(?:\+\d{1,3}[ -]?)?\(?\d{2,4}\)?[ -]\d{3,4}[ -]\d{3,4}\b/.test(text))
  if (contact) found.add(screenRisk >= 0.3 ? 'screen' : 'document')
  if (/\b(?:dear \w+|sincerely|agreement)\b/i.test(text)) found.add('document')
  return [...found]
}

let ocrModel: Florence2 | undefined

export default class SensitiveComposite {
  private readonly config: Config

  constructor(options: { config: Config }) {
    this.config = options.config
  }

  id(): string {
    return `sensitive-composite:${this.config.llm.model}`
  }

  async callApi(_prompt: string, context: { vars: { image?: string } }) {
    try {
      const image = context.vars.image
      if (!image) throw new Error('vars.image is missing')
      const c = this.config
      const t0 = performance.now()
      const stages: Record<string, number> = {}
      const meta: Record<string, number> = {}
      let loadMs = 0
      const note = (name: string, ms: number, load?: number) => {
        stages[name] = Math.round(ms - (load ?? 0))
        loadMs += load ?? 0
      }
      const strong: Partial<Record<Category, number>> = {}

      // 1. faces
      let t = performance.now()
      const faces = await detect(c.yunet, image)
      note('yunet', performance.now() - t, faces.loadMs)
      const area = Math.max(0, ...faces.found.map((f) => (f.box[2] - f.box[0]) * (f.box[3] - f.box[1])))
      if (faces.found.length >= 1 && faces.found.length <= 2 && area >= 0.04) strong.face = STRONG

      // 2. nsfw
      t = performance.now()
      const nsfw = await flagScore(c.nsfw, image)
      note('nsfw', performance.now() - t, nsfw.loadMs)
      if (nsfw.pFlag >= STRONG) strong.nudity = STRONG

      // 3. zero-shot
      t = performance.now()
      const zs = await zeroShotRisks(c.siglip, await imageOf(image))
      note('siglip', performance.now() - t, zs.loadMs)

      // 4. OCR, on every image
      ocrModel ??= new Florence2({ config: c.ocr })
      t = performance.now()
      const ocr = await ocrModel.ocrText(image)
      note('ocr', performance.now() - t, ocr.loadMs)
      for (const cat of textEvidence(ocr.lines, zs.categories.screen)) strong[cat] = STRONG
      const textLines = ocr.lines.filter((l) => (l.match(/[\p{L}\p{N}]/gu) ?? []).length >= 2).length

      // Decisive? (see the header)
      const privateHit = PRIVATE_CATEGORIES.some((cat) => strong[cat] !== undefined)
      const quiet =
        Object.keys(strong).length === 0 &&
        textLines === 0 &&
        nsfw.pFlag < 0.1 &&
        faces.found.length === 0 &&
        zs.ordinary >= ORDINARY_MIN &&
        CATEGORIES.every((cat) => zs.categories[cat] < zs.ordinary)
      const risks = {} as Record<Category, number>
      for (const cat of CATEGORIES) risks[cat] = strong[cat] ?? 0
      let decidedBy: 'rules' | 'public-signals' | 'llm'
      let loadedBytes: number | undefined
      if (privateHit) decidedBy = 'rules'
      else if (quiet) decidedBy = 'public-signals'
      else {
        decidedBy = 'llm'
        t = performance.now()
        const r = await rate(c.llm, image)
        note('llm', performance.now() - t, r.loadMs)
        loadedBytes = r.loadedBytes
        for (const cat of CATEGORIES) risks[cat] = Math.max(risks[cat], r.rated.categories[cat])
      }
      if (decidedBy !== 'llm') for (const cat of CATEGORIES) if (zs.categories[cat] >= 0.5) risks[cat] = Math.max(risks[cat], zs.categories[cat])

      for (const [name, ms] of Object.entries(stages)) meta[`${name}_ms`] = ms
      return {
        output: JSON.stringify({ categories: risks, level: levelFromRisks(risks), stages, decided_by: decidedBy, ordinary: zs.ordinary, ocr_lines: textLines }),
        metadata: {
          ...meta,
          classify_ms: performance.now() - t0 - loadMs,
          ...(loadMs > 0 ? { load_ms: loadMs } : {}),
          rss_mb: process.memoryUsage().rss / 2 ** 20,
          ran_ocr: 'ocr' in stages ? 1 : 0,
          ran_llm: 'llm' in stages ? 1 : 0,
          ...(loadedBytes === undefined ? {} : { loaded_bytes: loadedBytes }),
        },
      }
    } catch (err) {
      return { error: String(err) }
    }
  }
}
