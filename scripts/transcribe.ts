// Transcribes your own recordings: a `.txt` beside each audio or video file, with any model pinned in the
// transcribe suite (suites/transcribe/promptfooconfig.yaml). The same code as the suite's provider, outside promptfoo.
//
//   bun scripts/transcribe.ts <file-or-folder> [--model <label>]
//
// A folder is searched recursively. The default model is whisper-small-en. Needs ffmpeg (providers/media.ts); the first
// run of a model downloads its weights. An existing `.txt` is overwritten.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, extname } from 'node:path'
import { parseArgs } from 'node:util'
import { transcribe, type TranscribeConfig } from '../providers/transcribe.ts'
import { ROOT, SUITES_DIR } from './ledger.ts'

const DEFAULT_MODEL = 'whisper-small-en'
const MEDIA = new Set(['.ogg', '.oga', '.opus', '.wav', '.mp3', '.m4a', '.flac', '.aac', '.mp4', '.mov', '.mkv', '.webm', '.ogv'])

/** The suite's providers: label → config. */
function models(): Map<string, TranscribeConfig> {
  const setup = Bun.YAML.parse(readFileSync(join(SUITES_DIR, 'transcribe', 'promptfooconfig.yaml'), 'utf8')) as { providers: { label: string; config: TranscribeConfig }[] }
  return new Map(setup.providers.map((p) => [p.label, p.config]))
}

function mediaIn(path: string): string[] {
  if (statSync(path).isFile()) return [path]
  return readdirSync(path, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => (e.isDirectory() ? mediaIn(join(path, e.name)) : MEDIA.has(extname(e.name).toLowerCase()) ? [join(path, e.name)] : []))
}

const { values, positionals } = parseArgs({ args: Bun.argv.slice(2), options: { model: { type: 'string', default: DEFAULT_MODEL } }, allowPositionals: true })
const target = positionals[0]
const available = models()
const config = available.get(values.model!)
if (!target || !config) {
  console.error(target ? `unknown model ${values.model}; the suite has: ${[...available.keys()].join(', ')}` : 'usage: bun scripts/transcribe.ts <file-or-folder> [--model <label>]')
  process.exit(2)
}
const files = mediaIn(resolve(target))
if (files.length === 0) {
  console.error(`no audio or video files under ${target}`)
  process.exit(2)
}
for (const file of files) {
  // providers/media.ts reads paths relative to the repo; an absolute one outside it is joined onto ROOT, so pass a relative path.
  const r = await transcribe(config, relative(ROOT, file))
  const out = file.replace(/\.[^.]+$/, '.txt')
  writeFileSync(out, `${r.text}\n`)
  console.log(`${out}  ${r.audio_s.toFixed(1)} s audio, ${(r.transcribe_ms / 1000).toFixed(1)} s, ${r.rtf.toFixed(1)}x real time`)
}
