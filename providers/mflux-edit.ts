// promptfoo custom provider for image-editing models run by the mflux CLI
// (MLX, Apple silicon; no Ollama). Used by the edit suite.
//
// The case's image and instruction go to `mflux-generate-flux2-edit`, which
// loads the weights, edits the image and exits, so nothing stays in memory
// afterwards (the judge in assertions/edit.ts is an Ollama model; the two are
// never loaded together). The edited PNG is re-encoded as a JPEG at quality
// 85 and saved under results/edits/<suite>/<model label>/<case id>-<hash>.jpg,
// which is committed, so the site and the judge can read it later.
//
// Config: `model_dir` (the weights folder), or `repo` and `revision`, which
// resolve to .cache/models/<repo>/<revision> (the same pinned-commit layout
// as the ONNX models; the provider errors if the folder is missing, it never
// downloads); `base_model` (mflux's name for the architecture, e.g.
// flux2-klein-4b); `label` (the provider's own label, repeated here because
// promptfoo does not hand it to the provider; names the output folder);
// `seed` (default 42); `steps` (default: the model's own); `command` (default mflux-generate-flux2-edit); `suite` (default `edit`, the
// folder under results/edits/).
//
// Vars: `image` (the source image), `instruction` (what to change). The
// output size is the source's own, rounded to a multiple of 16.
//
// Output: {"image": "results/edits/<suite>/<label>/<case>-<hash>.jpg"}, a
// path from the repo root (under private/ with EVALS_SCOPE=private). Metadata:
// edit_ms (wall time of the CLI, loading included), peak_mb (its peak memory
// footprint, from /usr/bin/time -l), width, height.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnRunnerAsync } from '@osdlc/command-seam'
import sharp from 'sharp'

interface Config {
  command?: string
  model_dir?: string
  repo?: string
  revision?: string
  base_model: string
  seed?: number
  steps?: number
  label: string
  suite?: string
}

// Providers run inside promptfoo's Node, so no Bun-only import.meta.dir here.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PRIVATE = process.env['EVALS_SCOPE'] === 'private'
// The CLI takes minutes on a cold load; never cut it short (the runner's own
// per-case limit, PROMPTFOO_EVAL_TIMEOUT_MS, is the backstop).
const TIMEOUT_MS = 30 * 60_000

/** The bytes of an image var: a data URL or bare base64, as promptfoo passes a file:// image. */
const bytesOf = (v: string | undefined): Buffer => {
  if (!v) throw new Error('vars.image is missing')
  return Buffer.from(v.replace(/^data:image\/[a-z]+;base64,/, ''), 'base64')
}

const round16 = (n: number) => Math.max(16, Math.round(n / 16) * 16)

/** `/usr/bin/time -l` on macOS: "  46.29 real ..." and "  12345678  peak memory footprint" (bytes). */
export function parseTime(stderr: string): { realS: number; peakMb: number } | null {
  const real = /^\s*([\d.]+)\s+real/m.exec(stderr)?.[1]
  const peak = /^\s*(\d+)\s+peak memory footprint/m.exec(stderr)?.[1]
  return real && peak ? { realS: Number(real), peakMb: Number(peak) / 2 ** 20 } : null
}

export default class MfluxEdit {
  private readonly config: Config

  constructor(options: { config: Config }) {
    this.config = options.config
  }

  id(): string {
    return `mflux-edit:${this.config.label}`
  }

  private modelDir(): string {
    const { model_dir, repo, revision } = this.config
    const dir = model_dir ?? (repo && revision ? join(ROOT, '.cache', 'models', repo, revision) : undefined)
    if (!dir) throw new Error('config needs `model_dir`, or `repo` and `revision`')
    if (!existsSync(dir)) throw new Error(`weights not found at ${dir}; download ${repo ?? 'the model'}@${revision ?? ''} there first`)
    return dir
  }

  async callApi(_prompt: string, context: { vars: { image?: string; instruction?: string }; test?: { metadata?: { id?: string } } }) {
    const work = mkdtempSync(join(tmpdir(), 'mflux-edit-'))
    try {
      const { command = 'mflux-generate-flux2-edit', base_model, seed = 42, steps, suite = 'edit' } = this.config
      const instruction = context.vars.instruction
      if (!instruction) throw new Error('vars.instruction is missing')
      const caseId = context.test?.metadata?.id
      if (!caseId) throw new Error('the case has no metadata.id')
      const modelDir = this.modelDir()
      const source = bytesOf(context.vars.image)
      const { width: w, height: h } = await sharp(source).metadata()
      if (!w || !h) throw new Error('cannot read the image size')
      const width = round16(w)
      const height = round16(h)
      const input = join(work, 'input.jpg')
      const edited = join(work, 'edited.png')
      writeFileSync(input, await sharp(source).jpeg({ quality: 95 }).toBuffer())

      const t = performance.now()
      const res = await spawnRunnerAsync('/usr/bin/time').run(
        [
          '-l', command,
          '--model', modelDir,
          '--base-model', base_model,
          '--prompt', instruction,
          '--image-paths', input,
          '--width', String(width),
          '--height', String(height),
          '--seed', String(seed),
          ...(steps === undefined ? [] : ['--steps', String(steps)]),
          '--output', edited,
        ],
        { cwd: ROOT, timeoutMs: TIMEOUT_MS },
      )
      const wallMs = performance.now() - t
      if (res.exitCode !== 0 || !existsSync(edited)) throw new Error(`${command} exited ${res.exitCode}: ${res.stderr.slice(-600)}`)
      const timed = parseTime(res.stderr)

      const jpeg = await sharp(edited).jpeg({ quality: 85 }).toBuffer()
      const hash = createHash('sha256').update(jpeg).digest('hex').slice(0, 8)
      const out = join(ROOT, PRIVATE ? 'private' : '', 'results', 'edits', suite, this.config.label.replace(/[:/]/g, '_'), `${caseId}-${hash}.jpg`)
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, jpeg)
      return {
        output: JSON.stringify({ image: relative(ROOT, out) }),
        metadata: {
          edit_ms: timed ? timed.realS * 1000 : wallMs,
          ...(timed ? { peak_mb: Math.round(timed.peakMb) } : {}),
          width,
          height,
        },
      }
    } catch (err) {
      return { error: String(err) }
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }
}
