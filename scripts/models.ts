// The models the runner knows, smallest first so a problem shows up before
// the big loads. `label` is the provider label in the suites' configs;
// `tag` is what Ollama calls the model. To add a model: add it here and add
// a provider with this label to each suite it can run.
//
// `released` is the month the model (this version of it) came out. Small
// models are overtaken within a year, so the runner skips any model older
// than MAX_AGE_MONTHS unless it is a `baseline`: one a target app uses today,
// or the yardstick for a category that moves slowly, kept to show whether
// a switch is worth it. Dates marked `approx` are from memory, unchecked.
export interface ModelEntry {
  label: string
  /** The Ollama tag, or for an ONNX model its Hugging Face id. */
  tag: string
  released: string
  approx?: true
  baseline?: string
  /** `onnx`: run in-process with transformers.js (providers/image-classifier.ts), not by Ollama. */
  runtime?: 'onnx'
  /** For an ONNX model: the pinned Hugging Face commit, used as its digest. */
  revision?: string
  /** For an ONNX model: the weights' precision, as transformers.js names it. */
  dtype?: string
}

export const MAX_AGE_MONTHS = 12

export const MODELS: ModelEntry[] = [
  { label: 'nomic-embed-text', tag: 'nomic-embed-text:latest', released: '2024-02', approx: true, baseline: 'a common default embedder; switching means re-indexing' },
  { label: 'granite4', tag: 'granite4:latest', released: '2025-10', approx: true, baseline: 'the previous Granite generation, yardstick for granite4.2' },
  { label: 'qwen3:4b', tag: 'qwen3:4b', released: '2025-04', approx: true, baseline: 'a common local default; yardstick for qwen3.5' },
  { label: 'gemma3:4b', tag: 'gemma3:4b', released: '2025-03', approx: true },
  { label: 'qwen3.5:4b', tag: 'qwen3.5:4b', released: '2026-02', approx: true },
  { label: 'qwen3.5:9b', tag: 'qwen3.5:9b', released: '2026-02', approx: true },
  { label: 'gemma4:e4b', tag: 'gemma4:e4b', released: '2026-04', approx: true },
  { label: 'granite4.2:3b', tag: 'granite4.2:3b', released: '2026-08', approx: true },
  { label: 'minicpm5-2b', tag: 'openbmb/minicpm5-2b:latest', released: '2026-09', approx: true },
  { label: 'lfm3:1.7b', tag: 'lfm3:1.7b', released: '2026-10', approx: true },
  { label: 'lfm3-vl:2b', tag: 'lfm3-vl:2b', released: '2026-10', approx: true },
  // Dedicated classifiers age slowly next to generative models; the age limit is for the latter.
  { label: 'vit-nsfw-adamcodd-q8', tag: 'AdamCodd/vit-base-nsfw-detector', released: '2024-12', runtime: 'onnx', revision: '8587de998f441aac03fdd57a85d2e4cb808c7d64', dtype: 'q8', baseline: 'dedicated NSFW classifier, ~86M parameters' },
  { label: 'vit-nsfw-falconsai-q8', tag: 'onnx-community/nsfw_image_detection-ONNX', released: '2025-05', runtime: 'onnx', revision: '1ceb3c7fe1e9f3f2507e6df577437f23a9149fd5', dtype: 'q8', baseline: 'dedicated NSFW classifier, ~86M parameters (Falconsai, ONNX conversion)' },
  { label: 'd1-omni:600m', tag: 'd1-omni:600m', released: '2026-10', approx: true },
  { label: 'd1:2b', tag: 'd1:2b', released: '2026-10', approx: true },
]

/** Whole months from `released` (YYYY-MM) to `now`. */
export function ageMonths(released: string, now = new Date()): number {
  const [y, m] = released.split('-').map(Number) as [number, number]
  return (now.getUTCFullYear() - y) * 12 + (now.getUTCMonth() + 1 - m)
}

/** Why a model is skipped, or null when it runs. */
export function skipReason(model: ModelEntry, now = new Date()): string | null {
  const age = ageMonths(model.released, now)
  if (age <= MAX_AGE_MONTHS || model.baseline) return null
  return `released ${model.released}, ${age} months ago (over ${MAX_AGE_MONTHS}); add \`baseline\` to keep running it`
}
