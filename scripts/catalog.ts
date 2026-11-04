// What each model in scripts/models.ts is, where to get it and under what
// licence: facts a person wants beside its scores. Keyed by the registry label.
// scripts/check.ts fails when a registry label has no entry here or an entry
// lacks `url`, `kind`, `publisher` or `licence`.
//
// Do not repeat what results/models/<digest>.json already holds from the
// build itself (Ollama's family, quantization, context length, capabilities,
// parameter count): the site shows those beside this. Here goes what no build
// reports. Every fact comes from the Hugging Face API/model card or the
// ollama.com library page, checked 2026-11-02; leave a field out rather than
// guess, and say in `notes` when something is unverified.

/** The job a model does, for filtering. */
export type ModelKind =
  | 'llm'
  | 'vision-llm'
  | 'embedder'
  /** A model that answers typed questions with calibrated probabilities in one pass (Liquid AI d1). */
  | 'decision-model'
  | 'classifier'
  | 'detector'
  | 'open-vocab-detector'
  | 'ocr-detector'
  | 'face-detector'
  /** One model that does several prompted vision tasks (Florence-2). */
  | 'multitask-vision'
  | 'image-editor'
  /** An image encoder whose vectors rank images by likeness (DINO, CLIP, SigLIP). */
  | 'image-embedder'
  /** A fixed-size fingerprint computed by plain code, no weights. */
  | 'perceptual-hash'
  /** An image-text encoder pair scoring an image against text prompts it was never trained on as classes (SigLIP, CLIP). */
  | 'zero-shot-classifier'
  /** A pipeline of several models, cheap ones first (the sensitive suite's composite). */
  | 'composite'

export type Modality = 'text' | 'image' | 'audio' | 'boxes' | 'labels' | 'probabilities' | 'embedding'

export interface CatalogEntry {
  /** Where to get the build we run: its Ollama library page, or its Hugging Face repo. */
  url: string
  /** The upstream repository the build derives from, when `url` is a conversion or a library page. */
  source_url?: string
  /** The organisation that trained the model. */
  publisher: string
  /** SPDX id where one exists, else the licence's short name. */
  licence: string
  /** The licence text, when it is not a standard one. */
  licence_url?: string
  kind: ModelKind
  inputs: Modality[]
  outputs: Modality[]
  /** Total weights, from the Hugging Face safetensors metadata (counts every tower and embedding). */
  parameters?: number
  /** Why `parameters` is not the whole story (effective vs total, a different checkpoint, ...). */
  parameters_note?: string
  architecture?: string
  /** The upstream model this one is converted or fine-tuned from, as a Hugging Face id. */
  base_model?: string
  /** Download size as run, in GB (10^9 bytes). For Ollama, `ollama list`; for ONNX, the files the provider loads. */
  disk_gb?: number
  languages?: string
  paper?: string
  /** 1-3 sentences: what it is, quirks we found. */
  notes: string
}

const hf = (repo: string) => `https://huggingface.co/${repo}`
const ollama = (tag: string) => `https://ollama.com/library/${tag}`
const arxiv = (id: string) => `https://arxiv.org/abs/${id}`

const LFM_LANGS = 'English, Arabic, Chinese, French, German, Italian, Japanese, Korean, Portuguese, Spanish, Vietnamese, Thai, Indonesian, Hindi, Russian, Polish'
const LFM_LICENCE = 'LFM Open License v1.0'
const lfmLicence = (repo: string) => hf(`${repo}/blob/main/LICENSE`)
const DINOV3_LICENCE = 'DINOv3 License (Meta, custom; not Apache or MIT)'

const encoder = (e: Pick<CatalogEntry, 'url' | 'source_url' | 'publisher' | 'licence' | 'parameters' | 'parameters_note' | 'architecture' | 'base_model' | 'disk_gb' | 'paper' | 'notes'> & { licence_url?: string }): CatalogEntry => ({
  kind: 'image-embedder',
  inputs: ['image'],
  outputs: ['embedding'],
  ...e,
})

const hash = (notes: string, architecture: string): CatalogEntry => ({
  url: 'https://github.com/sksizer/small-model-evals/blob/main/providers/image-embed.ts',
  source_url: 'https://github.com/JohannesBuchner/imagehash',
  publisher: 'this repo',
  licence: 'MIT (our code)',
  kind: 'perceptual-hash',
  inputs: ['image'],
  outputs: ['embedding'],
  architecture,
  notes,
})

const GRANITE_LANGS = 'English, German, Spanish, French, Japanese, Portuguese, Arabic, Czech, Italian, Korean, Dutch, Chinese'

const florence = (task: string, notes: string): CatalogEntry => ({
  url: hf('onnx-community/Florence-2-base'),
  source_url: hf('microsoft/Florence-2-base'),
  publisher: 'Microsoft',
  licence: 'MIT',
  kind: 'multitask-vision',
  inputs: ['image', 'text'],
  outputs: ['text', 'boxes'],
  parameters: 231_567_705,
  parameters_note: 'The original microsoft/Florence-2-base checkpoint.',
  architecture: `Sequence-to-sequence vision-language model driven by task prompts; run here for ${task}`,
  base_model: 'microsoft/Florence-2-base',
  // The four q8 files transformers.js loads: embed_tokens, vision_encoder, encoder_model, decoder_model_merged.
  disk_gb: 0.275,
  paper: arxiv('2311.06242'),
  notes,
})

const dfine = (repo: string, source: string, parameters: number, disk_gb: number, notes: string): CatalogEntry => ({
  url: hf(repo),
  source_url: hf(source),
  publisher: 'USTC (ustc-community)',
  licence: 'Apache-2.0',
  kind: 'detector',
  inputs: ['image'],
  outputs: ['boxes', 'labels'],
  parameters,
  parameters_note: `The original ${source} checkpoint.`,
  architecture: 'D-FINE: real-time DETR-style detector, 80 COCO classes',
  base_model: source,
  disk_gb,
  paper: arxiv('2410.13842'),
  notes,
})

export const CATALOG: Record<string, CatalogEntry> = {
  'nomic-embed-text': {
    url: ollama('nomic-embed-text'),
    source_url: hf('nomic-ai/nomic-embed-text-v1.5'),
    publisher: 'Nomic AI',
    licence: 'Apache-2.0',
    kind: 'embedder',
    inputs: ['text'],
    outputs: ['embedding'],
    parameters: 136_731_648,
    architecture: 'nomic-bert text encoder',
    base_model: 'nomic-ai/nomic-embed-text-v1.5',
    disk_gb: 0.274,
    paper: arxiv('2402.01613'),
    notes: 'The Ollama `latest` tag is v1.5. The embedder the speed suite times (about 102 embeds/s in a batch of 64).',
  },
  granite4: {
    url: ollama('granite4'),
    source_url: hf('ibm-granite/granite-4.0-micro'),
    publisher: 'IBM',
    licence: 'Apache-2.0',
    kind: 'llm',
    inputs: ['text'],
    outputs: ['text'],
    parameters: 3_402_836_480,
    parameters_note: 'The weight count matches granite-4.0-micro exactly, the dense 3B; the Ollama `latest` tag is that model.',
    architecture: 'Dense decoder transformer (the "micro" size; the -h sizes are hybrid Mamba-2)',
    base_model: 'ibm-granite/granite-4.0-micro-base',
    disk_gb: 2.1,
    languages: GRANITE_LANGS,
    notes: 'The previous Granite generation, kept as the yardstick for granite4.2. Fast (about 40 tok/s here) and strong at orchestrate (14/15), weak at workout.',
  },
  'qwen3:4b': {
    url: ollama('qwen3:4b'),
    source_url: hf('Qwen/Qwen3-4B'),
    publisher: 'Qwen (Alibaba)',
    licence: 'Apache-2.0',
    kind: 'llm',
    inputs: ['text'],
    outputs: ['text'],
    parameters: 4_022_468_096,
    parameters_note: 'The weight count matches Qwen/Qwen3-4B and its 2507 variants, which are the same size.',
    architecture: 'Dense decoder transformer',
    disk_gb: 2.5,
    paper: arxiv('2505.09388'),
    notes: 'The Ollama tag advertises a 256K context, which the other qwen3 tags (40K) do not, so it may be a 2507 checkpoint; which one is unverified. Its orchestrate latency is several times the others (it may not honour think: false with tools).',
  },
  'gemma3:4b': {
    url: ollama('gemma3:4b'),
    source_url: hf('google/gemma-3-4b-it'),
    publisher: 'Google',
    licence: 'Gemma Terms of Use',
    licence_url: 'https://ai.google.dev/gemma/terms',
    kind: 'vision-llm',
    inputs: ['text', 'image'],
    outputs: ['text'],
    parameters: 4_300_079_472,
    parameters_note: 'Includes the vision encoder.',
    architecture: 'Decoder-only multimodal transformer',
    base_model: 'google/gemma-3-4b-pt',
    disk_gb: 3.3,
    notes: 'Older than the 12-month limit, so the runner skips it (it has no baseline flag); its classify row is stale.',
  },
  'qwen3.5:4b': {
    url: ollama('qwen3.5:4b'),
    source_url: hf('Qwen/Qwen3.5-4B'),
    publisher: 'Qwen (Alibaba)',
    licence: 'Apache-2.0',
    kind: 'vision-llm',
    inputs: ['text', 'image'],
    outputs: ['text'],
    parameters: 4_659_865_088,
    parameters_note: 'Includes the vision encoder; the language model alone is 4B.',
    architecture: 'Hybrid Gated DeltaNet and gated-attention language model with a vision encoder',
    base_model: 'Qwen/Qwen3.5-4B-Base',
    disk_gb: 4.0,
    notes: 'The strongest small model here for nudity-flag (73/77) and a top box-drawer, but it merges text lines (regions-text 0/8). Ollama 0.40.11 ignores num_ctx for it, so its 8K and 32K speed rows are the 4K load again.',
  },
  'qwen3.5:9b': {
    url: ollama('qwen3.5:9b'),
    source_url: hf('Qwen/Qwen3.5-9B'),
    publisher: 'Qwen (Alibaba)',
    licence: 'Apache-2.0',
    kind: 'vision-llm',
    inputs: ['text', 'image'],
    outputs: ['text'],
    parameters: 9_653_104_368,
    parameters_note: 'Includes the vision encoder.',
    architecture: 'Hybrid Gated DeltaNet and gated-attention language model with a vision encoder',
    base_model: 'Qwen/Qwen3.5-9B-Base',
    disk_gb: 7.6,
    notes: 'Among the most accurate models in the registry (regions-find 18/18, classify 20/20, orchestrate 15/15), at about 23 tok/s and 7.9 GB loaded on the 16 GiB Mac. Same num_ctx caveat as qwen3.5:4b.',
  },
  'gemma4:e4b': {
    url: ollama('gemma4'),
    source_url: hf('google/gemma-4-E4B-it'),
    publisher: 'Google DeepMind',
    licence: 'Apache-2.0',
    licence_url: 'https://ai.google.dev/gemma/docs/gemma_4_license',
    kind: 'vision-llm',
    inputs: ['text', 'image', 'audio'],
    outputs: ['text'],
    parameters: 7_996_156_490,
    parameters_note: 'Total with per-layer embeddings; Google counts 4.5B effective parameters.',
    architecture: 'Decoder transformer interleaving sliding-window and global attention, with per-layer embeddings; vision and audio encoders',
    base_model: 'google/gemma-4-E4B',
    disk_gb: 9.6,
    paper: arxiv('2607.02770'),
    notes: 'Flags nothing in nudity-flag (0/9 explicit nudes), which looks like a safety filter, so its 68/77 means nothing for that job. Weak at drawing boxes (regions-objects 3/14). /api/ps likely omits its per-layer embeddings, so its loaded-memory column is unreliable.',
  },
  'granite4.2:3b': {
    url: ollama('granite4.2:3b'),
    source_url: hf('ibm-granite/granite-4.2-3b'),
    publisher: 'IBM',
    licence: 'Apache-2.0',
    kind: 'llm',
    inputs: ['text'],
    outputs: ['text'],
    parameters: 3_659_737_600,
    architecture: 'Decoder-only dense transformer (GraniteForCausalLM)',
    base_model: 'ibm-granite/granite-4.1-3b-base',
    disk_gb: 2.2,
    languages: GRANITE_LANGS,
    notes: 'The newer Granite, with a thinking mode. It did not beat granite4 on most suites here (classify 12/20 vs 14/20, food-lookup 3/12 vs 7/12).',
  },
  'minicpm5-2b': {
    url: 'https://ollama.com/openbmb/minicpm5-2b',
    source_url: hf('openbmb/MiniCPM5-2B'),
    publisher: 'OpenBMB',
    licence: 'Apache-2.0',
    kind: 'llm',
    inputs: ['text'],
    outputs: ['text'],
    parameters: 2_516_756_480,
    architecture: 'Dense LlamaForCausalLM',
    disk_gb: 1.6,
    notes: 'A hybrid-reasoning (think / no-think) 2B for on-device assistants. About 58 tok/s here, but middling on quality (workout 2/16, route 6/18).',
  },
  'lfm3:1.7b': {
    url: ollama('lfm3'),
    source_url: hf('LiquidAI/LFM3-1.7B'),
    publisher: 'Liquid AI',
    licence: LFM_LICENCE,
    licence_url: lfmLicence('LiquidAI/LFM3-1.7B'),
    kind: 'llm',
    inputs: ['text'],
    outputs: ['text'],
    parameters: 1_728_801_536,
    architecture: 'Tri-hybrid, 24 layers: 13 gated short convolutions, 5 sliding-window attention, 6 global attention',
    base_model: 'LiquidAI/LFM3-1.7B-Base',
    disk_gb: 1.7,
    languages: LFM_LANGS,
    notes: 'Made for local agents and tool calls; Liquid says it is not for agentic coding or multi-step reasoning. It labels almost everything "task" in classify (4/20), and with no output cap it ran to the 5-minute timeout.',
  },
  'lfm3-vl:2b': {
    url: ollama('lfm3-vl'),
    source_url: hf('LiquidAI/LFM3-VL-2B'),
    publisher: 'Liquid AI',
    licence: LFM_LICENCE,
    licence_url: lfmLicence('LiquidAI/LFM3-VL-2B'),
    kind: 'vision-llm',
    inputs: ['text', 'image'],
    outputs: ['text'],
    parameters: 1_918_181_888,
    parameters_note: '1.73B language model, 164M vision encoder, 25M projector.',
    architecture: 'LFM3 language model with a 14-layer convolution and attention vision encoder, native-resolution patches',
    base_model: 'LiquidAI/LFM3-1.7B-Base',
    disk_gb: 1.7,
    languages: LFM_LANGS,
    notes: 'The smallest model that boxes things well (regions-objects 12/14, regions-find 15/18) at 1-2 s per image, and the best LLM at text-line boxes (5/8). It flags too much art and swimwear in nudity-flag (58/77).',
  },
  'vit-nsfw-adamcodd-q8': {
    url: hf('AdamCodd/vit-base-nsfw-detector'),
    publisher: 'AdamCodd',
    licence: 'Apache-2.0',
    kind: 'classifier',
    inputs: ['image'],
    outputs: ['labels', 'probabilities'],
    parameters: 86_092_034,
    architecture: 'ViT-base, patch 16, 384 px input, fine-tuned for NSFW detection',
    base_model: 'google/vit-base-patch16-384',
    disk_gb: 0.089,
    paper: arxiv('2010.11929'),
    notes: 'Catches every explicit nude (9/9) but flags 7 of 8 swimsuit photos, so it over-flags. Runs in about 0.1 s per image.',
  },
  'vit-nsfw-falconsai-q8': {
    url: hf('onnx-community/nsfw_image_detection-ONNX'),
    source_url: hf('Falconsai/nsfw_image_detection'),
    publisher: 'Falconsai',
    licence: 'Apache-2.0',
    kind: 'classifier',
    inputs: ['image'],
    outputs: ['labels', 'probabilities'],
    parameters: 85_800_194,
    parameters_note: 'The original Falconsai checkpoint; the ONNX repo reports no count.',
    architecture: 'ViT image classifier',
    base_model: 'Falconsai/nsfw_image_detection',
    disk_gb: 0.087,
    paper: arxiv('2010.11929'),
    notes: 'The ONNX repo carries no licence tag; Apache-2.0 is the licence of the original Falconsai model. Conservative: spares art and swimwear but catches only 3 of 9 explicit nudes.',
  },
  'dfine-n': dfine(
    'onnx-community/dfine_n_coco-ONNX',
    'ustc-community/dfine-nano-coco',
    3_798_993,
    0.015,
    'The nano D-FINE, converted to ONNX by onnx-community (the ONNX repo carries no licence tag; the original is Apache-2.0). Weak here: at the 0.5 threshold it returns almost nothing (regions-objects 0/14).',
  ),
  'dfine-n-t0.3': dfine(
    'onnx-community/dfine_n_coco-ONNX',
    'ustc-community/dfine-nano-coco',
    3_798_993,
    0.015,
    'The same model and revision as dfine-n, scored at threshold 0.3 because it is under-confident at 0.5. It barely improves (1/14), so the threshold is not the cause.',
  ),
  'dfine-s': dfine(
    'onnx-community/dfine_s_coco-ONNX',
    'ustc-community/dfine-small-coco',
    10_350_057,
    0.042,
    'The small D-FINE, converted to ONNX by onnx-community. 5/14 on regions-objects in about 0.1 s per image. Like RT-DETR it answers in the old VOC class names and needs a label map.',
  ),
  'rtdetr-r18': {
    url: hf('onnx-community/rtdetr_r18vd'),
    source_url: hf('PekingU/rtdetr_r18vd'),
    publisher: 'PekingU (Peking University)',
    licence: 'Apache-2.0',
    kind: 'detector',
    inputs: ['image'],
    outputs: ['boxes', 'labels'],
    parameters: 20_209_680,
    parameters_note: 'The original PekingU/rtdetr_r18vd checkpoint.',
    architecture: 'RT-DETR real-time detector, ResNet-18 vd backbone, 80 COCO classes',
    base_model: 'PekingU/rtdetr_r18vd',
    disk_gb: 0.083,
    paper: arxiv('2304.08069'),
    notes: 'The ONNX repo carries no licence tag; Apache-2.0 is the original\'s. 6/14 on regions-objects in about 0.1 s per image; answers in VOC class names (pottedplant, diningtable, tvmonitor) and needs a label map.',
  },
  'owlv2-base-q8': {
    url: hf('onnx-community/owlv2-base-patch16-ensemble-ONNX'),
    source_url: hf('google/owlv2-base-patch16-ensemble'),
    publisher: 'Google',
    licence: 'Apache-2.0',
    kind: 'open-vocab-detector',
    inputs: ['image', 'text'],
    outputs: ['boxes', 'labels'],
    parameters: 154_966_791,
    parameters_note: 'The original google/owlv2-base-patch16-ensemble checkpoint.',
    architecture: 'OWLv2: open-vocabulary detector on a CLIP backbone, patch 16, ensemble checkpoint',
    base_model: 'google/owlv2-base-patch16-ensemble',
    disk_gb: 0.163,
    paper: arxiv('2306.09683'),
    notes: 'The ONNX repo carries no licence tag; Apache-2.0 is the original\'s. Middling at finding named things (11/18) and cannot box text lines at all (0/8). About 1.5 s per image.',
  },
  'grounding-dino-tiny-q8': {
    url: hf('onnx-community/grounding-dino-tiny-ONNX'),
    source_url: hf('IDEA-Research/grounding-dino-tiny'),
    publisher: 'IDEA-Research',
    licence: 'Apache-2.0',
    kind: 'open-vocab-detector',
    inputs: ['image', 'text'],
    outputs: ['boxes', 'labels'],
    parameters: 172_277_902,
    parameters_note: 'The original IDEA-Research/grounding-dino-tiny checkpoint.',
    architecture: 'Grounding DINO: text-conditioned open-vocabulary detector (tiny)',
    base_model: 'IDEA-Research/grounding-dino-tiny',
    disk_gb: 0.204,
    paper: arxiv('2303.05499'),
    notes: 'Only works with one joined prompt ("dog . car ."); a label list errors in the ONNX export (join_phrases). 12/18 on regions-find, 0/8 on text lines, about 1.2 s per image.',
  },
  'florence2-base-od-q8': florence(
    'object detection (<OD>)',
    'Run for object detection: 4/14 on regions-objects but a strong 12/15 on faces, at about 0.8 s per image.',
  ),
  'florence2-base-ground-q8': florence(
    'phrase grounding',
    'Run for phrase grounding: 14/18 on regions-find and 5/15 on faces, at about 0.8 s per image.',
  ),
  'florence2-base-ocr-q8': florence(
    '<OCR_WITH_REGION>',
    'Run for OCR with regions: found every text line on all 8 pages (regions-text 8/8, F1 0.99) in about 1.8 s per page, the best of anything tried on text.',
  ),
  'yunet-2023mar': {
    url: hf('opencv/face_detection_yunet'),
    source_url: 'https://github.com/ShiqiYu/libfacedetection.train',
    publisher: 'OpenCV (opencv_zoo), model by Shiqi Yu',
    licence: 'MIT',
    kind: 'face-detector',
    inputs: ['image'],
    outputs: ['boxes'],
    architecture: 'YuNet: light-weight CNN face detector, fixed input shape',
    disk_gb: 0.0002,
    paper: 'https://link.springer.com/article/10.1007/s11633-023-1423-y',
    notes: 'The fp32 2023-March build (0.23 MB). Detects faces of about 10x10 to 300x300 pixels. Matches the LLMs on faces (13/15) in under 10 ms. Parameter count not confirmed.',
  },
  'ppocr-v5-mobile-det': {
    url: hf('PaddlePaddle/PP-OCRv5_mobile_det_onnx'),
    publisher: 'PaddlePaddle',
    licence: 'Apache-2.0',
    kind: 'ocr-detector',
    inputs: ['image'],
    outputs: ['boxes'],
    architecture: 'PP-OCRv5 mobile text-line detector (detection only, no recognition)',
    disk_gb: 0.005,
    notes: 'Finds text-line boxes only; 6/8 on regions-text in under 50 ms. Parameter count and paper not confirmed.',
  },
  'phash': hash(
    'Our own 64-bit DCT hash (providers/image-embed.ts): grayscale 32x32, lowest 8x8 frequencies, bit set above the median; no weights. The source link is the imagehash library whose recipe it follows; we do not run it. Compare with Hamming similarity.',
    'Perceptual hash: DCT of a 32x32 grayscale thumbnail, 64 bits',
  ),
  'dhash': hash(
    'Our own 64-bit gradient hash (providers/image-embed.ts): grayscale 9x8, one bit per pixel that is darker than its right neighbour; no weights. The source link is the imagehash library whose recipe it follows; we do not run it. Compare with Hamming similarity.',
    'Difference hash: left-to-right gradient of a 9x8 grayscale thumbnail, 64 bits',
  ),
  'dinov2-small': encoder({
    url: hf('onnx-community/dinov2-small'),
    source_url: hf('facebook/dinov2-small'),
    publisher: 'Meta AI',
    licence: 'Apache-2.0',
    parameters: 22_056_576,
    parameters_note: 'The original facebook/dinov2-small checkpoint.',
    architecture: 'DINOv2 ViT-S/14, self-supervised; the CLS token of the final layer is the image vector',
    base_model: 'facebook/dinov2-small',
    disk_gb: 0.0885,
    paper: arxiv('2304.07193'),
    notes: 'The ONNX repo carries no licence tag; Apache-2.0 is the licence of the original. fp32, 224 px (resize 256, centre crop 224, so a 10% crop loses the edge it was already missing). Image-only: it has no text tower, so it cannot search by text.',
  }),
  'dinov2-base': encoder({
    url: hf('onnx-community/dinov2-base'),
    source_url: hf('facebook/dinov2-base'),
    publisher: 'Meta AI',
    licence: 'Apache-2.0',
    parameters: 86_580_480,
    parameters_note: 'The original facebook/dinov2-base checkpoint.',
    architecture: 'DINOv2 ViT-B/14, self-supervised; the CLS token of the final layer is the image vector',
    base_model: 'facebook/dinov2-base',
    disk_gb: 0.3466,
    paper: arxiv('2304.07193'),
    notes: 'The ONNX repo carries no licence tag; Apache-2.0 is the licence of the original. fp32, 224 px.',
  }),
  'dinov3-vits16': encoder({
    url: hf('onnx-community/dinov3-vits16-pretrain-lvd1689m-ONNX'),
    source_url: hf('facebook/dinov3-vits16-pretrain-lvd1689m'),
    publisher: 'Meta AI',
    licence: DINOV3_LICENCE,
    licence_url: hf('onnx-community/dinov3-vits16-pretrain-lvd1689m-ONNX/blob/main/LICENSE.md'),
    parameters: 21_596_544,
    parameters_note: 'The original facebook/dinov3-vits16-pretrain-lvd1689m checkpoint (gated upstream; the ONNX conversion is not).',
    architecture: 'DINOv3 ViT-S/16 with 4 register tokens, self-supervised; the pooled CLS token is the image vector',
    base_model: 'facebook/dinov3-vits16-pretrain-lvd1689m',
    disk_gb: 0.0864,
    paper: arxiv('2508.10104'),
    notes: 'NOT Apache or MIT. Meta\'s custom DINOv3 licence (read it before shipping): a limited, non-transferable, royalty-free grant; redistribution must carry the agreement; use must comply with trade controls and may not serve military or warfare, nuclear or espionage ends; no reverse engineering; it ends if you sue Meta over the materials; Meta may amend it. Checked against the LICENSE.md in the ONNX repo, 2026-11-03. fp32, 224 px.',
  }),
  'siglip2-base': encoder({
    url: hf('onnx-community/siglip2-base-patch16-224-ONNX'),
    source_url: hf('google/siglip2-base-patch16-224'),
    publisher: 'Google',
    licence: 'Apache-2.0',
    parameters: 375_187_970,
    parameters_note: 'Both towers of the original google/siglip2-base-patch16-224; only the vision tower (about a quarter of it, unconfirmed) runs for similarity.',
    architecture: 'SigLIP 2 ViT-B/16 vision tower with an attention-pooling head; the pooled output is the image vector',
    base_model: 'google/siglip2-base-patch16-224',
    disk_gb: 0.3718,
    paper: arxiv('2502.14786'),
    notes: 'The ONNX repo carries no licence tag; Apache-2.0 is the licence of the original. Runs onnx/vision_model.onnx at fp32, so the 1.1 GB text tower is never read. Also embeds text, so the same vectors can serve text-to-image search.',
  }),
  'clip-vit-b32': encoder({
    url: hf('Xenova/clip-vit-base-patch32'),
    source_url: hf('openai/clip-vit-base-patch32'),
    publisher: 'OpenAI',
    licence: 'MIT',
    licence_url: 'https://github.com/openai/CLIP/blob/main/LICENSE',
    architecture: 'CLIP ViT-B/32 vision tower with its projection; the projected image embedding is the vector',
    base_model: 'openai/clip-vit-base-patch32',
    disk_gb: 0.3517,
    paper: arxiv('2103.00020'),
    notes: 'MIT per OpenAI\'s GitHub release (confirmed); the Hugging Face repos list MIT or no licence. Xenova\'s export rather than onnx-community\'s, which holds only one combined text+vision model. Runs onnx/vision_model.onnx at fp32. Parameter count not confirmed.',
  }),
  'clip-vit-b16': encoder({
    url: hf('Xenova/clip-vit-base-patch16'),
    source_url: hf('openai/clip-vit-base-patch16'),
    publisher: 'OpenAI',
    licence: 'MIT',
    licence_url: 'https://github.com/openai/CLIP/blob/main/LICENSE',
    architecture: 'CLIP ViT-B/16 vision tower with its projection; the projected image embedding is the vector',
    base_model: 'openai/clip-vit-base-patch16',
    disk_gb: 0.3451,
    paper: arxiv('2103.00020'),
    notes: 'MIT per OpenAI\'s GitHub release (confirmed); the Hugging Face repo has no licence tag. Xenova\'s export rather than onnx-community\'s, which holds only one combined text+vision model. Runs onnx/vision_model.onnx at fp32. Parameter count not confirmed.',
  }),
  'siglip2-base-zs': {
    url: hf('onnx-community/siglip2-base-patch16-224-ONNX'),
    source_url: hf('google/siglip2-base-patch16-224'),
    publisher: 'Google',
    licence: 'Apache-2.0',
    kind: 'zero-shot-classifier',
    inputs: ['image', 'text'],
    outputs: ['probabilities'],
    parameters: 375_187_970,
    parameters_note: 'Both towers of the original google/siglip2-base-patch16-224; the sensitive suite runs the text tower once per run (to embed the prompts) and the vision tower per image.',
    architecture: 'SigLIP 2 ViT-B/16 with a text tower; per-prompt sigmoid scores from the checkpoint\'s logit scale (112.669) and bias (-16.772)',
    base_model: 'google/siglip2-base-patch16-224',
    disk_gb: 1.5,
    paper: arxiv('2502.14786'),
    notes: 'Same pinned revision as siglip2-base, plus onnx/text_model.onnx (1.1 GB) at fp32. The logit scale and bias were recovered from the combined model.onnx by fitting its logits against the two towers\' cosines (exact to 2e-6). A category is present at sigmoid >= 0.5; the suite page shows the threshold sweep.',
  },
  'clip-vit-b16-zs': {
    url: hf('Xenova/clip-vit-base-patch16'),
    source_url: hf('openai/clip-vit-base-patch16'),
    publisher: 'OpenAI',
    licence: 'MIT',
    licence_url: 'https://github.com/openai/CLIP/blob/main/LICENSE',
    kind: 'zero-shot-classifier',
    inputs: ['image', 'text'],
    outputs: ['probabilities'],
    architecture: 'CLIP ViT-B/16, both towers; softmax over positive and negative prompts at logit scale 100',
    base_model: 'openai/clip-vit-base-patch16',
    disk_gb: 0.6,
    paper: arxiv('2103.00020'),
    notes: 'Same pinned revision as clip-vit-b16, plus onnx/text_model.onnx at fp32. A category is present when its best prompt beats the best generic negative prompt (risk >= 0.5 by construction); the suite page shows the threshold sweep.',
  },
  'composite-qwen3.5-4b': {
    url: 'https://github.com/sksizer/small-model-evals/blob/main/providers/sensitive-composite.ts',
    publisher: 'this repo',
    licence: 'MIT (our code)',
    kind: 'composite',
    inputs: ['image'],
    outputs: ['labels', 'probabilities'],
    architecture: 'YuNet faces, Falconsai NSFW ViT, SigLIP 2 zero-shot, Florence-2 OCR with regexes, then qwen3.5:4b only when no signal is decisive',
    notes: 'Its models are pinned in the suite config, except qwen3.5:4b, which is pinned by Ollama\'s digest in the qwen3.5:4b entry. The rules for "decisive" are in the provider\'s header; each result records which stages ran and their times. Its memory figure is the in-process specialists only; when qwen3.5:4b is called, Ollama holds that model besides.',
  },
  'flux2-klein-4b-q4': {
    url: hf('mflux-community/flux2-klein-4b-mflux-q4'),
    source_url: hf('black-forest-labs/FLUX.2-klein-4B'),
    publisher: 'Black Forest Labs',
    licence: 'Apache-2.0',
    kind: 'image-editor',
    inputs: ['image', 'text'],
    outputs: ['image'],
    parameters: 3_875_544_576,
    parameters_note: 'The full-precision black-forest-labs/FLUX.2-klein-4B checkpoint; the q4 build quantizes the same weights.',
    architecture: 'Latent flow transformer for image-to-image editing, 4-bit MLX build for mflux',
    base_model: 'black-forest-labs/FLUX.2-klein-4B',
    disk_gb: 4.6,
    notes: 'Passed 9/10 edit cases at 35-45 s per edit (4 steps, loading included), peaking near 11.5 GB of the 16 GB machine. Its one failure replaced a removed bowl with a cup.',
  },
  'd1-omni:600m': {
    url: ollama('d1-omni'),
    source_url: hf('LiquidAI/d1-omni-600M'),
    publisher: 'Liquid AI',
    licence: LFM_LICENCE,
    licence_url: lfmLicence('LiquidAI/d1-omni-600M'),
    kind: 'decision-model',
    inputs: ['text', 'image'],
    outputs: ['probabilities'],
    parameters: 587_161_089,
    parameters_note: 'Hugging Face safetensors total; the Ollama build reports 380.7M and the library page calls it 600M, and we have not reconciled the three.',
    architecture: 'Multimodal decision model: answers typed questions with calibrated probabilities in one forward pass, no text generated',
    base_model: 'LiquidAI/LFM2.5-Encoder-350M',
    disk_gb: 0.849,
    paper: arxiv('2511.23404'),
    notes: 'Not a chat model: it is asked questions through Ollama\'s /v1/systemone endpoint. Misses almost every explicit nude (1/9 in nudity-flag) and does poorly at route (6/18).',
  },
  'd1:2b': {
    url: ollama('d1'),
    source_url: hf('LiquidAI/d1-2B'),
    publisher: 'Liquid AI',
    licence: LFM_LICENCE,
    licence_url: lfmLicence('LiquidAI/d1-2B'),
    kind: 'decision-model',
    inputs: ['text', 'image'],
    outputs: ['probabilities'],
    parameters: 1_918_181_888,
    parameters_note: 'The Ollama build reports 1,918,174,720.',
    architecture: 'Decision model on LFM3-VL-2B: typed questions answered with calibrated probabilities in one forward pass, no text generated',
    base_model: 'LiquidAI/LFM3-VL-2B',
    disk_gb: 3.9,
    languages: LFM_LANGS,
    notes: 'Not a chat model: asked through /v1/systemone. Strong at route (15/18) and catches all 9 explicit nudes, but flags every swimsuit photo (0/8 cleared). The Ollama tag is stored as BF16, hence 3.9 GB for 1.9B parameters.',
  },
}
