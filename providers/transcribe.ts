// promptfoo custom provider for the transcribe suite: speech in, the transcript out. The same code runs
// outside promptfoo, from scripts/transcribe.ts, through the exported `transcribe`.
//
// TranscribeConfig, by `family` (one per runtime, docs/plans/transcribe.md):
// - `transformers`: an ONNX speech model in-process (transformers.js `automatic-speech-recognition`
//   pipeline, onnxruntime-node). `model` (Hugging Face id), `revision` (commit, so the weights never change
//   under a snapshot), `dtype` (q8 by default). Whisper and its distilled students take clips over 30 s
//   in 30 s windows with 5 s strides (the pipeline's own chunking); a model the pipeline cannot chunk
//   (Moonshine) gets windows of up to 15 s cut at the quietest moment near the end of each, so a cut rarely
//   lands inside a word. Moonshine tiny returned nothing for 27 s windows of speech that it read fine in 15 s ones.
// - `whisper-cpp` and `apple` are planned (docs/plans/transcribe.md, stage 3) and throw until they exist.
//
// The clip is `vars.audio` (a repo path, decoded to 16 kHz mono by providers/media.ts); the prompt is unused.
// Output: the transcript as plain text (assertions/wer.ts). Metadata: audio_s (length of the clip),
// transcribe_ms, rtf (seconds of audio per second of compute: 4 is four times faster than real time), load_ms
// (first case only) and rss_mb (process memory after transcribing, an upper bound on the model's footprint).
import { pipeline } from '@huggingface/transformers'
import { samples } from './media.ts'

const RATE = 16000
/** The Whisper pipeline's window and stride, and the longest stretch handed to any other model in one go. */
const WINDOW_S = 30
const STRIDE_S = 5
const OTHER_WINDOW_S = 15
/** A cut falls in the quietest 0.1 s of the last 3 s of the window. */
const CUT_SEARCH_S = 3
const CUT_FRAME_S = 0.1

export interface TranscribeConfig {
  family: 'transformers' | 'whisper-cpp' | 'apple'
  model: string
  revision: string
  dtype?: 'fp32' | 'fp16' | 'q8' | 'int8' | 'uint8' | 'q4' | 'bnb4' | 'q4f16'
}

export interface Transcription {
  text: string
  audio_s: number
  transcribe_ms: number
  /** Seconds of audio per second of compute. */
  rtf: number
  /** Set when this call paid for loading the model. */
  load_ms?: number
}

type Asr = (audio: Float32Array, options?: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>

const loaded = new Map<string, Promise<Asr>>()

/** Cut points (sample indexes) so that no piece is longer than `windowS`; each cut is at the quietest frame near a piece's end. */
export function cutPoints(audio: Float32Array, windowS = OTHER_WINDOW_S): number[] {
  const max = windowS * RATE
  const frame = Math.floor(CUT_FRAME_S * RATE)
  const cuts: number[] = []
  let start = 0
  while (audio.length - start > max) {
    let best = start + max
    let quietest = Infinity
    for (let at = start + max - CUT_SEARCH_S * RATE; at + frame <= start + max; at += frame) {
      let energy = 0
      for (let i = at; i < at + frame; i++) energy += audio[i]! * audio[i]!
      if (energy < quietest) {
        quietest = energy
        best = at + Math.floor(frame / 2)
      }
    }
    cuts.push(best)
    start = best
  }
  return cuts
}

const isWhisper = (model: string) => /whisper/i.test(model)

async function transformers(c: TranscribeConfig, audio: Float32Array): Promise<Omit<Transcription, 'audio_s' | 'rtf'>> {
  const { model, revision, dtype = 'q8' } = c
  const key = `${model}@${revision}:${dtype}`
  let loadMs: number | undefined
  if (!loaded.has(key)) {
    const t = performance.now()
    const p = pipeline('automatic-speech-recognition', model, { revision, dtype }) as unknown as Promise<Asr>
    loaded.set(key, p)
    await p
    loadMs = performance.now() - t
  }
  const asr = await loaded.get(key)!
  const words = (r: Awaited<ReturnType<Asr>>) => (Array.isArray(r) ? r.map((x) => x.text).join(' ') : r.text).trim()
  const t0 = performance.now()
  let text: string
  const whisper = isWhisper(model)
  if (audio.length <= (whisper ? WINDOW_S : OTHER_WINDOW_S) * RATE) text = words(await asr(audio))
  else if (whisper) text = words(await asr(audio, { chunk_length_s: WINDOW_S, stride_length_s: STRIDE_S }))
  else {
    const edges = [0, ...cutPoints(audio), audio.length]
    const parts: string[] = []
    for (let i = 0; i + 1 < edges.length; i++) parts.push(words(await asr(audio.subarray(edges[i]!, edges[i + 1]!))))
    text = parts.join(' ')
  }
  return { text, transcribe_ms: performance.now() - t0, ...(loadMs === undefined ? {} : { load_ms: loadMs }) }
}

/** Transcribes the clip at `file` (a repo path). */
export async function transcribe(c: TranscribeConfig, file: string): Promise<Transcription> {
  const audio = samples(file, RATE)
  if (c.family !== 'transformers') throw new Error(`transcribe: family ${c.family} is not built yet`)
  const r = await transformers(c, audio)
  const audioS = audio.length / RATE
  return { ...r, audio_s: audioS, rtf: audioS / (r.transcribe_ms / 1000) }
}

export default class Transcribe {
  private readonly config: TranscribeConfig

  constructor(options: { config: TranscribeConfig }) {
    this.config = options.config
  }

  id(): string {
    return `transcribe:${this.config.model}@${this.config.revision.slice(0, 7)}`
  }

  async callApi(_prompt: string, context: { vars: { audio?: string } }) {
    try {
      const file = context.vars.audio
      if (!file) throw new Error('vars.audio is missing')
      const { text, audio_s, transcribe_ms, rtf, load_ms } = await transcribe(this.config, file)
      return {
        output: text,
        metadata: { audio_s, transcribe_ms, rtf, ...(load_ms === undefined ? {} : { load_ms }), rss_mb: process.memoryUsage().rss / 2 ** 20 },
      }
    } catch (err) {
      return { error: String(err) }
    }
  }
}
