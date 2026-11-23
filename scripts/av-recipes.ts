// The transformations that make the audio and video search suite's `copy` clips, the clip-to-clip
// counterpart of scripts/recipes.ts: scripts/fetch-av.ts applies them (through scripts/ffmpeg.ts),
// scripts/pick-av.ts names them. Each keeps a clip recognisably the same recording, and each is
// deterministic (the committed bytes are what the suite uses, so a later ffmpeg cannot move them).
// A copy still has to be a valid stored clip: sounds 5 to 30 s, videos 5 to 15 s.

/** `start` and `length` are functions of the parent's duration, in seconds. */
export interface AudioRecipe {
  about: string
  start: (parent: number) => number
  length: (parent: number) => number
  kbps: number
  gainDb: number
}

const tenths = (x: number) => Math.round(x * 10) / 10

export const AUDIO_RECIPES = {
  trim: { about: 'The middle 60%: 20% cut from the start and 20% from the end.', start: (d) => tenths(d * 0.2), length: (d) => tenths(d * 0.6), kbps: 24, gainDb: 0 },
  recode: { about: 'The whole clip at 8 kbps instead of 24.', start: () => 0, length: (d) => d, kbps: 8, gainDb: 0 },
  quiet: { about: 'The whole clip 9 dB quieter.', start: () => 0, length: (d) => d, kbps: 24, gainDb: -9 },
} satisfies Record<string, AudioRecipe>

export interface VideoRecipe {
  about: string
  start: number
  /** Seconds kept, or null for all of it. */
  length: number | null
  crf: number
}

export const VIDEO_RECIPES = {
  reencode: { about: 'The whole clip re-encoded at a much lower quality (CRF 38 instead of 28).', start: 0, length: null, crf: 38 },
  cut: { about: 'Six seconds from the second second, re-encoded.', start: 2, length: 6, crf: 30 },
} satisfies Record<string, VideoRecipe>

/**
 * The `noisy` clips of the transcription suite (docs/plans/transcribe.md): a read clip with a corpus sound mixed
 * under it, the speech `snrDb` decibels louder than the sound. The entry names the sound (`noise`); the copy
 * credits both. Unlike the copies above it keeps its parent's reference transcript.
 */
export interface NoiseRecipe {
  about: string
  snrDb: number
}

export const NOISE_RECIPES = {
  snr10: { about: 'The clip mixed with a corpus sound 10 dB quieter than the speech: easy to hear through.', snrDb: 10 },
  snr0: { about: 'The clip mixed with a corpus sound as loud as the speech.', snrDb: 0 },
} satisfies Record<string, NoiseRecipe>

export type AudioRecipeName = keyof typeof AUDIO_RECIPES
export type VideoRecipeName = keyof typeof VIDEO_RECIPES
export type NoiseRecipeName = keyof typeof NOISE_RECIPES
export type AvRecipe = AudioRecipeName | VideoRecipeName | NoiseRecipeName
