// Audio and video decoding for the search providers (providers/search.ts), through ffmpeg run by the command
// seam. Providers run inside promptfoo's Node, so nothing here may be Bun-only; scripts/ffmpeg.ts, which builds
// the corpus, is the Bun side. ffmpeg must be on PATH (`brew install ffmpeg`, scripts/setup.ts reports it).
//
// A clip is an item whose `file` is audio (`.ogg`) or video (`.mp4`); every other file is an image. Decoded
// frames are kept under .cache/av/ (a clip's bytes never change, so neither do they); audio is decoded each time.
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnRunner, spawnRunnerBytes } from '@osdlc/command-seam'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = join(ROOT, '.cache', 'av')

export type Medium = 'text' | 'image' | 'audio' | 'video'

/** What an item holds, from its file: none is text, `.ogg` is audio, `.mp4` is video, anything else an image. */
export function mediumOf(item: { file?: string }): Medium {
  if (!item.file) return 'text'
  if (/\.(ogg|oga|opus|wav)$/i.test(item.file)) return 'audio'
  return /\.(mp4|webm|ogv)$/i.test(item.file) ? 'video' : 'image'
}

const ffmpegArgs = (args: string[]) => ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args]

/** The clip as mono 32-bit float samples at `rate` Hz (16000 for EmbeddingGemma 2 and Whisper, 48000 for CLAP). */
export function samples(file: string, rate: number): Float32Array {
  const res = spawnRunnerBytes('ffmpeg').run(ffmpegArgs(['-i', join(ROOT, file), '-vn', '-ac', '1', '-ar', String(rate), '-f', 'f32le', 'pipe:1']), { cwd: ROOT })
  if (res.exitCode !== 0) throw new Error(`ffmpeg failed on ${file}: ${res.stderr.trim().split('\n').slice(-2).join(' | ')}`)
  const b = res.stdout
  // Copy: a Buffer may sit at an odd offset in a shared pool, which a Float32Array view cannot.
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength - (b.byteLength % 4)))
}

/** Paths of the clip's frames as JPEGs, `fps` per second from the first (1 is EmbeddingGemma 2's default). */
export function frames(file: string, fps = 1): string[] {
  const dir = join(CACHE, 'frames', `${fps}fps`, file.replace(/[/.]/g, '_'))
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    const res = spawnRunner('ffmpeg').run(ffmpegArgs(['-i', join(ROOT, file), '-vf', `fps=${fps}`, '-q:v', '3', join(dir, 'f%03d.jpg')]), { cwd: ROOT })
    const out = readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort()
    if (res.exitCode !== 0 || out.length === 0) {
      rmSync(dir, { recursive: true, force: true }) // no half-made folder for the next call to trust
      throw new Error(`ffmpeg found no frames in ${file}: ${res.stderr.trim().split('\n').slice(-2).join(' | ')}`)
    }
  }
  return readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort().map((f) => join(dir, f))
}
