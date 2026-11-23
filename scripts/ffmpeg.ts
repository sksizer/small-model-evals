// ffmpeg and ffprobe, run through the command seam. They convert source clips
// into the formats docs/standards/corpus.md fixes for audio and video, and
// (in later stages) decode clips at run time. Installed by hand
// (`brew install ffmpeg`); scripts/setup.ts reports it when missing.
import { spawnRunner } from '@osdlc/command-seam'
import { UA } from './commons.ts'
import { ROOT } from './ledger.ts'

/** The stored audio: 16 kHz mono Opus in an Ogg container, ~24 kbps for sound and for speech meant for transcription, ~16 kbps for the speech of the search suite. */
export const AUDIO_EXT = 'ogg'
/** The stored video: 360p H.264 in MP4, no sound track. */
export const VIDEO_EXT = 'mp4'

/** Why ffmpeg cannot be used here, or null when it can. */
export function ffmpegProblem(): string | null {
  if (!Bun.which('ffmpeg') || !Bun.which('ffprobe')) return '`ffmpeg`/`ffprobe` are not on PATH: run `brew install ffmpeg`'
  const enc = spawnRunner('ffmpeg').run(['-hide_banner', '-encoders'], { cwd: ROOT }).stdout
  for (const need of ['libopus', 'libx264']) if (!enc.includes(need)) return `ffmpeg lacks the ${need} encoder: reinstall with \`brew install ffmpeg\``
  return null
}

/** Run ffmpeg on `input` (a path or URL); throws with ffmpeg's last words when it fails. */
function ffmpeg(args: string[]): void {
  const res = spawnRunner('ffmpeg').run(['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { cwd: ROOT })
  if (res.exitCode !== 0) throw new Error(`ffmpeg failed: ${res.stderr.trim().split('\n').slice(-3).join(' | ')}`)
}

// A URL input needs the polite user agent Commons asks for; a local path ignores it.
const input = (src: string): string[] => (/^https?:/.test(src) ? ['-user_agent', UA, '-i', src] : ['-i', src])
// No container metadata, and bitexact muxing, so the bytes depend only on the audio or pictures.
const CLEAN = ['-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', '-flags:v', '+bitexact']

// Seeking before the input is fast (a URL is read by range) but some Ogg files cannot be seeked
// that way and yield an empty output; `slow` decodes from the start instead.
const seek = (start: number, duration: number, src: string, slow: boolean): string[] =>
  slow ? [...input(src), '-ss', String(start), '-t', String(duration)] : ['-ss', String(start), '-t', String(duration), ...input(src)]

/** `duration` seconds from `start` of `src`, as 16 kHz mono Opus (`kbps` bits per second) into `out`. */
export function toAudio(src: string, out: string, start: number, duration: number, kbps: number, slow = false): void {
  ffmpeg([...seek(start, duration, src, slow), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', `${kbps}k`, '-application', 'audio', ...CLEAN, out])
}

/** `duration` seconds from `start` of `src`, as 360p 15 fps H.264 with the sound track dropped, into `out`. */
export function toVideo(src: string, out: string, start: number, duration: number, slow = false): void {
  ffmpeg([
    ...seek(start, duration, src, slow),
    '-an', '-vf', 'fps=15,scale=-2:360:flags=bicubic', '-c:v', 'libx264', '-preset', 'veryslow', '-crf', '28', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', ...CLEAN, out,
  ])
}

/**
 * `duration` seconds from `start` of a stored clip, as Opus at `kbps` with `gainDb` decibels of volume
 * change, into `out`: a derived copy (scripts/av-recipes.ts). Stays 16 kHz mono like every stored sound.
 */
export function reencodeAudio(src: string, out: string, start: number, duration: number, kbps: number, gainDb: number): void {
  ffmpeg([
    ...seek(start, duration, src, false), '-vn', '-ac', '1', '-ar', '16000', ...(gainDb === 0 ? [] : ['-af', `volume=${gainDb}dB`]),
    '-c:a', 'libopus', '-b:a', `${kbps}k`, '-application', 'audio', ...CLEAN, out,
  ])
}

/** The utterances `srcs`, one after the other with nothing between them, as 16 kHz mono Opus at `kbps` into `out`. */
export function joinAudio(srcs: string[], out: string, kbps: number): void {
  const n = srcs.length
  ffmpeg([
    ...srcs.flatMap((s) => ['-i', s]),
    '-filter_complex', `${srcs.map((_, i) => `[${i}:a]`).join('')}concat=n=${n}:v=0:a=1`,
    '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', `${kbps}k`, '-application', 'audio', ...CLEAN, out,
  ])
}

/** The RMS level of the whole clip in dB (full scale is 0), as ffmpeg's astats reports it. */
export function rmsDb(path: string): number {
  const res = spawnRunner('ffmpeg').run(['-hide_banner', '-nostdin', '-i', path, '-af', 'astats=metadata=0', '-f', 'null', '-'], { cwd: ROOT })
  const m = /Overall[\s\S]*?RMS level dB:\s*(-?[\d.]+)/.exec(res.stderr)
  if (res.exitCode !== 0 || !m) throw new Error(`could not measure the level of ${path}`)
  return Number(m[1])
}

/**
 * `speech` with `noise` mixed under it so that speech is `snrDb` decibels louder than the noise (RMS over the
 * whole of each clip), as Opus at `kbps` into `out`. The noise loops if it is shorter; the result is as long as
 * the speech, 3 dB quieter overall and limited, so that a 0 dB mix does not clip.
 */
export function mixAudio(speech: string, noise: string, out: string, snrDb: number, kbps: number): void {
  const gain = rmsDb(speech) - snrDb - rmsDb(noise)
  const length = probe(speech).duration
  ffmpeg([
    '-i', speech, '-stream_loop', '-1', '-i', noise,
    '-filter_complex', `[1:a]aresample=16000,volume=${gain.toFixed(2)}dB[n];[0:a][n]amix=inputs=2:duration=first:normalize=0,volume=-3dB,alimiter=limit=0.9`,
    '-t', String(length), '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', `${kbps}k`, '-application', 'audio', ...CLEAN, out,
  ])
}

/** `duration` seconds from `start` of a stored video, re-encoded at constant quality `crf` into `out`: a derived copy. Same 360p, 15 fps, no sound track. */
export function reencodeVideo(src: string, out: string, start: number, duration: number, crf: number): void {
  ffmpeg([
    ...seek(start, duration, src, false),
    '-an', '-vf', 'fps=15,scale=-2:360:flags=bicubic', '-c:v', 'libx264', '-preset', 'veryslow', '-crf', String(crf), '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', ...CLEAN, out,
  ])
}

/** What ffprobe reports about a stored clip. */
export interface Probe {
  duration: number
  width: number | undefined
  height: number | undefined
  audio: boolean
}

export function probe(path: string): Probe {
  const res = spawnRunner('ffprobe').run(['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', path], { cwd: ROOT })
  if (res.exitCode !== 0) throw new Error(`ffprobe failed on ${path}: ${res.stderr.trim()}`)
  const j = JSON.parse(res.stdout) as { streams: { codec_type: string; width?: number; height?: number }[]; format: { duration: string } }
  const v = j.streams.find((s) => s.codec_type === 'video')
  return { duration: Number(j.format.duration), width: v?.width, height: v?.height, audio: j.streams.some((s) => s.codec_type === 'audio') }
}

/** One frame, `at` seconds into the clip, as a 360p-high JPEG poster into `out`. */
export function poster(src: string, out: string, at: number): void {
  ffmpeg(['-ss', String(at), '-i', src, '-frames:v', '1', '-vf', 'scale=-2:360', '-q:v', '4', out])
}
