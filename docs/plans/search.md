# Plan: search (retrieval with embedding models)

Status: built (2026-11-05): `suites/search`, `providers/search.ts`, `assertions/search.ts`,
`scripts/pick-search.ts`; the text+image embedders are also providers of `similarity`
(`providers/similarity-search.ts`).

## Goal

Measure how well small embedding models find the right thing for a typed query, centred on EmbeddingGemma 2
(Apache-2.0, 740M: 270M text, 170M vision, 300M audio, one 768-d space), against the open and the restricted
rivals. Three kinds of case in one suite, each tagged `metadata.kind` (`photos`, `docs`, `text`); image to
image is the `similarity` suite's, where the multimodal models are added as providers.

## What was built, and why

- **One suite, three kinds.** Cases are `photos-*` (25: text to the 78 non-sensitive photos), `docs-*` (24:
  text to the 44 synthetic pages, searched as images, no OCR) and `text-*` (40: 15 over 1500 USDA SR Legacy
  foods, 25 over 60 invented notes). A provider lists the `kinds` it can take in its config; `scripts/run.ts`
  runs one promptfoo eval per kind with `--filter-metadata kind=...`, so a text-only model never gets a photo
  case (and shows no "not run" gap on the site, which counts only the cases a model takes).
- **Corpora live in the suite's setup** (`corpora.yaml`, inlined once into each snapshot), not in each case:
  a case names its corpus and its relevant ids. Nothing sensitive is searched (`scripts/check.ts` fails if a
  corpus lists a `sensitive` image).
- **Relevance.** Photos: 13 object queries ("a dog", "a bicycle", "a laptop") take Open Images V7 annotations
  (image-level labels at confidence 1, plus boxes) for the `oi-*` photos, extended by eye for the Commons
  photos Open Images does not cover; 12 descriptive queries ("two dogs looking out of a car window") were judged
  by eye. Open Images labels are sparse, so an object query is only as complete as the annotation. Docs: by eye.
  Foods: a regular expression on the name (in `scripts/pick-search.ts`; a case lists the matching ids in the
  1500-food subset, which always contains every food a rule calls relevant, filled with a seeded hash
  sample). Notes: judged by reading; 25 queries, many paraphrases ("teeth cleaning appointment" for a note
  that says "Dentist").
- **Scoring** (`assertions/search.ts`): nDCG@10 per query, passing at 0.7 (a lone relevant item at rank 1 scores
  1.0, at rank 2 0.63, at rank 3 0.5: the answer must be first or nearly), with recall@1/5/10 (capped at
  min(k, relevant) so one slot cannot be blamed for six relevant items) and MRR in the metadata.
  EmbeddingGemma 2 also records nDCG@10 at 256 dimensions (the card's MRL truncation, re-normalised).
- **Prefixes** are each model's documented ones: EmbeddingGemma 2 (and 1) `task: search result | query: `
  and `title: {title|none} | text: `, none for images; nomic `search_query: ` / `search_document: `;
  Qwen3-Embedding's `Instruct: ...\nQuery:` on queries only; Jina CLIP v2's retrieval prefix; SigLIP lowercased
  and padded to 64 tokens.

## Models

| Model | Runs | Notes |
| --- | --- | --- |
| `embeddinggemma2` (text + vision) | photos, docs, text | `onnx-community/embeddinggemma-2-ONNX` at q8, transformers.js. The card says never float16 (activations overflow to NaN) and fp32 is 1.8 GB for the two encoders, so q8 (509 MB; the repo reports 0.9997 cosine to fp32). The audio encoder is never loaded (`audio_config` removed). |
| `embeddinggemma2-text` | text | Same repo and revision, `vision_config` removed too (314 MB). |
| `siglip2-base`, `clip-vit-b16` | photos, docs | Existing labels and pinned revisions; text and vision towers. |
| `nomic-embed-v1.5-pair` | all | nomic-ai text and vision v1.5 (Apache-2.0), bare ONNX run with onnxruntime-node (transformers.js has no `nomic_bert`); the cards' pooling. |
| `jina-clip-v2` | all | CC BY-NC 4.0, **restricted**. q8 build, 865M, transformers.js' JinaCLIP. |
| `embeddinggemma:300m` | text | Ollama; Gemma Terms, **restricted**. Prefixes as EmbeddingGemma 2's (its gated card was not read). |
| `qwen3-embedding:0.6b`, `nomic-embed-text` | text | Ollama, Apache-2.0. |

Restricted models are marked in the catalogue (licence, and a "RESTRICTED:" note), and the finder's
"permissive licence only" filter leaves them out.

## Site

`/gallery/search/`: a model-by-kind table, then each query with its relevant items and every model's top five
(green relevant, red not; thumbnails or snippets). `/suites/search/` shows the same table above the case grid.
The finder offers three tasks, `search:photos`, `search:docs` and `search:text`: its cells are keyed by task id,
and the three are computed from the one suite's records by case kind (`scripts/export-site.ts`). The
leaderboard has a `search` family for the whole suite.

## Limits

- Small corpora (78 photos, 44 pages): many queries have one or two relevant items, so a single ranking flips
  a score; read differences of a few points as ties. The suite is near its ceiling for the best models, so it
  separates weak from strong more than strong from strong.
- Open Images labels are sparse; "a person" in particular depends on which classes were annotated.
- Times are per item embedded in one run of one machine; the SigLIP/CLIP memory figures include both towers.
