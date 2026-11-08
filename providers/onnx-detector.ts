// promptfoo custom provider for small detectors that ship as a bare ONNX file
// with no transformers.js class: run with onnxruntime-node, decoded here the
// way their reference code does. Used by the regions suites.
//
// `kind`:
// - `yunet`: OpenCV's YuNet face detector (2023mar, MIT). Decoded as
//   cv::FaceDetectorYN does: input BGR, unscaled, padded to a multiple of 32;
//   per stride (8, 16, 32) score = sqrt(cls * obj), centre = (cell + offset) *
//   stride, size = exp(v) * stride; then non-maximum suppression at IoU 0.3.
//   The image is first scaled so its long side is at most `size` (default
//   640, the export's input). Boxes are labelled `face`.
// - `dbnet`: PaddleOCR's PP-OCR text detector (DB). Pre- and post-processing
//   follow its inference.yml: long side resized to `size` (default 960, to a
//   multiple of 32), ImageNet normalisation in BGR order; the probability map
//   is cut at 0.3, each connected region kept when its mean probability is at
//   least 0.6 and grown by the DB unclip ratio 1.5 (as a rectangle: by
//   area * 1.5 / perimeter on every side). Boxes are labelled `text`.
//
// Config: `kind`, `repo` and `revision` (Hugging Face), `file` (the .onnx in
// that repo), `sha256` (checked after download, so the weights cannot change
// under a snapshot), `threshold` (YuNet score, default 0.6), `size`.
// Weights are cached in .cache/models/.
//
// Output matches assertions/regions.ts: {"boxes": [{label, score, box}]} with
// boxes as fractions of the image size. Metadata: detect_ms, load_ms (first
// case only), rss_mb, boxes.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as ort from 'onnxruntime-node'
import sharp from 'sharp'

export interface Config {
  kind: 'yunet' | 'dbnet'
  repo: string
  revision: string
  file: string
  sha256: string
  threshold?: number
  size?: number
}

type Box = [number, number, number, number]
export interface Found {
  label: string
  score: number
  box: Box
}

const CACHE = join(import.meta.dirname, '..', '.cache', 'models')
const sessions = new Map<string, Promise<ort.InferenceSession>>()

async function weights(c: Config): Promise<string> {
  const path = join(CACHE, c.repo, c.revision, c.file)
  if (!existsSync(path)) {
    const res = await fetch(`https://huggingface.co/${c.repo}/resolve/${c.revision}/${c.file}`)
    if (!res.ok) throw new Error(`${c.repo}/${c.file}: HTTP ${res.status}`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, new Uint8Array(await res.arrayBuffer()))
  }
  const got = createHash('sha256').update(readFileSync(path)).digest('hex')
  if (got !== c.sha256) throw new Error(`${c.repo}/${c.file}: sha256 ${got}, expected ${c.sha256}`)
  return path
}

/** The image scaled so its long side is at most `long`, as raw BGR bytes, plus its size. */
async function bgr(dataUrl: string, long: number, multiple: number) {
  const bytes = Buffer.from(dataUrl.replace(/^data:image\/[a-z]+;base64,/, ''), 'base64')
  const meta = await sharp(bytes).metadata()
  const scale = Math.min(1, long / Math.max(meta.width!, meta.height!))
  const round = (n: number) => (multiple > 1 ? Math.max(multiple, Math.round(n / multiple) * multiple) : Math.max(1, Math.round(n)))
  const w = round(meta.width! * scale)
  const h = round(meta.height! * scale)
  const { data } = await sharp(bytes).removeAlpha().resize(w, h, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true })
  return { rgb: data, w, h }
}

const iou = (a: Box, b: Box) => {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
  const inter = ix * iy
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)
}

function nms(found: Found[], limit: number): Found[] {
  const kept: Found[] = []
  for (const f of [...found].sort((a, b) => b.score - a.score)) if (kept.every((k) => iou(k.box, f.box) <= limit)) kept.push(f)
  return kept
}

async function yunet(s: ort.InferenceSession, dataUrl: string, c: Config): Promise<Found[]> {
  // This export has a fixed square input: the scaled image is padded to size x size.
  const size = c.size ?? 640
  const { rgb, w, h } = await bgr(dataUrl, size, 1)
  const pw = size
  const ph = size
  const input = new Float32Array(3 * ph * pw)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      // BGR planes, 0-255, zero padding right and bottom.
      input[y * pw + x] = rgb[i + 2]!
      input[1 * ph * pw + y * pw + x] = rgb[i + 1]!
      input[2 * ph * pw + y * pw + x] = rgb[i]!
    }
  const out = await s.run({ [s.inputNames[0]!]: new ort.Tensor('float32', input, [1, 3, ph, pw]) })
  const threshold = c.threshold ?? 0.6
  const found: Found[] = []
  for (const stride of [8, 16, 32]) {
    const cols = pw / stride
    const rows = ph / stride
    const cls = out[`cls_${stride}`]!.data as Float32Array
    const obj = out[`obj_${stride}`]!.data as Float32Array
    const bbox = out[`bbox_${stride}`]!.data as Float32Array
    for (let r = 0; r < rows; r++)
      for (let col = 0; col < cols; col++) {
        const i = r * cols + col
        const clamp = (v: number) => Math.min(1, Math.max(0, v))
        const score = Math.sqrt(clamp(cls[i]!) * clamp(obj[i]!))
        if (score < threshold) continue
        const cx = (col + bbox[i * 4]!) * stride
        const cy = (r + bbox[i * 4 + 1]!) * stride
        const bw = Math.exp(bbox[i * 4 + 2]!) * stride
        const bh = Math.exp(bbox[i * 4 + 3]!) * stride
        found.push({ label: 'face', score, box: [(cx - bw / 2) / w, (cy - bh / 2) / h, (cx + bw / 2) / w, (cy + bh / 2) / h] })
      }
  }
  return nms(found, 0.3)
}

async function dbnet(s: ort.InferenceSession, dataUrl: string, c: Config): Promise<Found[]> {
  const { rgb, w, h } = await bgr(dataUrl, c.size ?? 960, 32)
  const mean = [0.485, 0.456, 0.406]
  const std = [0.229, 0.224, 0.225]
  const input = new Float32Array(3 * h * w)
  for (let p = 0; p < w * h; p++) {
    // Channel order BGR (the image is decoded as BGR), normalised per channel.
    const px = [rgb[p * 3 + 2]!, rgb[p * 3 + 1]!, rgb[p * 3]!]
    for (let ch = 0; ch < 3; ch++) input[ch * w * h + p] = (px[ch]! / 255 - mean[ch]!) / std[ch]!
  }
  const out = await s.run({ [s.inputNames[0]!]: new ort.Tensor('float32', input, [1, 3, h, w]) })
  const prob = Object.values(out)[0]!.data as Float32Array
  const seen = new Uint8Array(w * h)
  const found: Found[] = []
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || prob[start]! <= 0.3) continue
    // Flood-fill one connected region of the cut map.
    let [x0, y0, x1, y1] = [w, h, 0, 0]
    let sum = 0
    let n = 0
    const stack = [start]
    seen[start] = 1
    while (stack.length > 0) {
      const p = stack.pop()!
      const x = p % w
      const y = (p - x) / w
      sum += prob[p]!
      n++
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q >= 0 && !seen[q] && prob[q]! > 0.3) {
          seen[q] = 1
          stack.push(q)
        }
      }
    }
    const score = sum / n
    if (score < 0.6 || x1 - x0 < 2 || y1 - y0 < 2) continue
    const bw = x1 - x0 + 1
    const bh = y1 - y0 + 1
    const d = (bw * bh * 1.5) / (2 * (bw + bh))
    found.push({
      label: 'text',
      score,
      box: [Math.max(0, x0 - d) / w, Math.max(0, y0 - d) / h, Math.min(w, x1 + 1 + d) / w, Math.min(h, y1 + 1 + d) / h],
    })
  }
  return found
}

/** Runs one detector on an image (a data URL); `loadMs` is set when this call paid for loading the weights. Shared with providers/sensitive-composite.ts. */
export async function detect(c: Config, dataUrl: string | undefined): Promise<{ found: Found[]; detectMs: number; loadMs?: number }> {
  const key = `${c.repo}@${c.revision}/${c.file}`
  let loadMs: number | undefined
  if (!sessions.has(key)) {
    const t = performance.now()
    const p = weights(c).then((path) => ort.InferenceSession.create(path))
    sessions.set(key, p)
    await p
    loadMs = performance.now() - t
  }
  const s = await sessions.get(key)!
  if (!dataUrl) throw new Error('vars.image is missing')
  const t = performance.now()
  const found = c.kind === 'yunet' ? await yunet(s, dataUrl, c) : await dbnet(s, dataUrl, c)
  return { found, detectMs: performance.now() - t, ...(loadMs === undefined ? {} : { loadMs }) }
}

export default class OnnxDetector {
  private readonly config: Config

  constructor(options: { config: Config }) {
    this.config = options.config
  }

  id(): string {
    return `onnx-detector:${this.config.repo}@${this.config.revision.slice(0, 7)}/${this.config.file}`
  }

  async callApi(_prompt: string, context: { vars: { image?: string } }) {
    try {
      const { found, detectMs, loadMs } = await detect(this.config, context.vars.image)
      const r4 = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 10000) / 10000
      const boxes = found.map((f) => ({ label: f.label, score: Math.round(f.score * 1000) / 1000, box: f.box.map(r4) }))
      return {
        output: JSON.stringify({ boxes }),
        metadata: {
          detect_ms: detectMs,
          ...(loadMs === undefined ? {} : { load_ms: loadMs }),
          rss_mb: process.memoryUsage().rss / 2 ** 20,
          boxes: boxes.length,
        },
      }
    } catch (err) {
      return { error: String(err) }
    }
  }
}
