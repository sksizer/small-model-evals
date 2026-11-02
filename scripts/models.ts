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
  // Region detectors (regions-* suites), in-process ONNX. Like the classifiers above, dedicated detectors age slowly.
  { label: 'dfine-n', tag: 'onnx-community/dfine_n_coco-ONNX', released: '2024-10', runtime: 'onnx', revision: '380d2839c327efaf65dd0fe0c2c10ab7fadd5473', dtype: 'fp32', baseline: 'D-FINE nano, ~4M parameters, 80 COCO classes, Apache-2.0' },
  { label: 'dfine-n-t0.3', tag: 'onnx-community/dfine_n_coco-ONNX', released: '2024-10', runtime: 'onnx', revision: '380d2839c327efaf65dd0fe0c2c10ab7fadd5473', dtype: 'fp32', baseline: 'D-FINE nano at score threshold 0.3 instead of 0.5 (it is under-confident at 0.5)' },
  { label: 'dfine-s', tag: 'onnx-community/dfine_s_coco-ONNX', released: '2024-10', runtime: 'onnx', revision: 'a3cf03147a9b86c78475139115c8ac142577352d', dtype: 'fp32', baseline: 'D-FINE small, ~10M parameters, 80 COCO classes, Apache-2.0' },
  { label: 'rtdetr-r18', tag: 'onnx-community/rtdetr_r18vd', released: '2023-04', runtime: 'onnx', revision: 'f2bee7444f4c29003df7e9ef07c4c1c6632eca6f', dtype: 'fp32', baseline: 'RT-DETR ResNet-18, ~20M parameters, 80 COCO classes, Apache-2.0' },
  { label: 'owlv2-base-q8', tag: 'onnx-community/owlv2-base-patch16-ensemble-ONNX', released: '2023-06', runtime: 'onnx', revision: '180d6ef7599bd69bb48db5c72bd49ad03ddfab80', dtype: 'q8', baseline: 'OWLv2 base, open-vocabulary detector, Apache-2.0' },
  { label: 'grounding-dino-tiny-q8', tag: 'onnx-community/grounding-dino-tiny-ONNX', released: '2023-03', runtime: 'onnx', revision: 'ff690b0a8050566c290287545bd059350f3e9096', dtype: 'q8', baseline: 'Grounding DINO tiny, open-vocabulary detector, Apache-2.0' },
  { label: 'florence2-base-od-q8', tag: 'onnx-community/Florence-2-base', released: '2024-06', runtime: 'onnx', revision: 'd59e079711c57174f29265539fb4cc9f0f335916', dtype: 'q8', baseline: 'Florence-2 base (~230M), <OD> task, MIT' },
  { label: 'florence2-base-ground-q8', tag: 'onnx-community/Florence-2-base', released: '2024-06', runtime: 'onnx', revision: 'd59e079711c57174f29265539fb4cc9f0f335916', dtype: 'q8', baseline: 'Florence-2 base (~230M), phrase grounding, MIT' },
  { label: 'florence2-base-ocr-q8', tag: 'onnx-community/Florence-2-base', released: '2024-06', runtime: 'onnx', revision: 'd59e079711c57174f29265539fb4cc9f0f335916', dtype: 'q8', baseline: 'Florence-2 base (~230M), <OCR_WITH_REGION>, MIT' },
  { label: 'yunet-2023mar', tag: 'opencv/face_detection_yunet', released: '2023-03', runtime: 'onnx', revision: '3cc26e7f1014a5ee5d74a42acee58bafc9d0a310', dtype: 'fp32', baseline: 'YuNet face detector, 0.2 MB, MIT' },
  { label: 'ppocr-v5-mobile-det', tag: 'PaddlePaddle/PP-OCRv5_mobile_det_onnx', released: '2025-05', runtime: 'onnx', revision: 'e6f4fa85f00e168c862bc462aebca69eef9b3d3d', dtype: 'fp32', baseline: 'PP-OCRv5 mobile text detector, 4.8 MB, Apache-2.0' },
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
