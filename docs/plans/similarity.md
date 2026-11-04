# Plan: image similarity

Status: built (2026-11-03): `suites/similarity`, `providers/image-embed.ts`, `assertions/similarity.ts`. The
owner's answers to the questions below: report every level; pHash and dHash only (no PDQ); include DINOv3 and show
its licence. What differs from the plan:

- **Queries and pool.** 29 queries against 153 candidates, not "about 30 against 121 + copies + edits": the pool is
  the 82 non-sensitive, non-face corpus photos, 4 new Open Images photos, 58 generated copies and the 10 edit
  outputs. Nothing sensitive, nudity-related or swimwear is in it.
- **Copies are committed corpus images**, two per query (recipes in `scripts/recipes.ts`, derived entries in
  `corpus/sources.yaml`), not generated on the fly: the corpus is immutable and sha256-checked, a derived image
  keeps its parent's credit, the site can show it like any other, and its bytes do not move with a `sharp` upgrade.
- **Scene is thin.** The corpus has one real series (the three Black Forest trail photos); the other desk and
  coffee photos only share a photographer or a theme and are `class`. Added four Open Images photos (two of one
  Triumph Spitfire, two of one Monaco race) for two more pairs: 7 queries have a `scene` level.
- **Labels follow the original.** A copy of another dog photo is a `class` match for a dog query, so a candidate's
  level is the level of the photo it came from.
- **Score.** Average precision over copy, edit and scene (class and other are reported, not scored). Per-level
  recall@1/@5 are capped at what is possible and measured with the stronger levels set aside (copies before
  edits before scenes before class), so a model is not marked down for ranking a copy above an edit. The cut-off check is per case (best single cut-off for copies and for
  copy+edit+scene, at most one mistake), not one cut-off for the whole suite.
- **CLIP weights** are Xenova's exports (`Xenova/clip-vit-base-patch32`, `-patch16`) with a separate
  `vision_model.onnx`; `onnx-community`'s CLIP repos hold only one combined text+vision model. Both are MIT (OpenAI's
  release, confirmed). SigLIP 2 runs `onnx/vision_model.onnx` from the onnx-community repo. All encoders run at fp32
  (each vision file is under 400 MB).
- **Hashes** are our own small implementations over `sharp` (runtime `local` in `scripts/models.ts`, no
  weights).
- The sensitive-images plan's SigLIP/CLIP provider is not shared yet: `providers/image-embed.ts` loads the vision
  tower only.

## Goal

Measure how well small models can tell "is this the same image, the same scene, or just the same
kind of thing?" Typical uses:
- finding duplicates in a photo library;
- grouping burst shots;
- spotting a re-upload of a known image;
- "more like this" search.

## Models

All run in-process, as ONNX through transformers.js (`image-feature-extraction`), except the
hashes, which are a few lines of code over `sharp`.

| Model | Size | Kind | Strength |
| --- | --- | --- | --- |
| pHash / dHash | none | Perceptual hash | Near-copies only: resized, recompressed, lightly cropped. Microseconds |
| PDQ (Meta) | none | Perceptual hash | Built for re-upload matching; needs a port or a WASM build (check). Dropped: the owner chose pHash and dHash only |
| CLIP ViT-B/32 and B/16 (`onnx-community/clip-vit-base-patch32-ONNX`, `-patch16-ONNX`) | ~150M both towers (unchecked) | Image-text embedding | Matches on meaning; can also search by text. Hugging Face shows no licence tag; OpenAI's release is MIT (to confirm) |
| SigLIP 2 base (`onnx-community/siglip2-base-patch16-224-ONNX`) | 375M both towers; only the image tower runs for similarity | Image-text embedding | Newer, usually stronger than CLIP at the same size. Apache-2.0 |
| DINOv2 small/base (`onnx-community/dinov2-small`, `dinov2-base`) | 22M / 86M | Self-supervised visual | Same object or scene from another view; fine detail. Apache-2.0 |
| DINOv3 ViT-S/16 (`onnx-community/dinov3-vits16-pretrain-lvd1689m-ONNX`) | 22M | Self-supervised visual | The newer DINO. Meta's own DINOv3 licence (not Apache); the upstream repo is gated behind accepting it, the ONNX conversion isn't |

## Cases

A case is a **query image and a list of candidates**, each labelled with how it relates to the
query. Levels:

| Level | Made from | Should match for |
| --- | --- | --- |
| `copy` | The query resized, recompressed (JPEG q40), cropped 10%, flipped, or brightness-shifted | Every use |
| `edit` | Our own edit suite outputs: the same photo with one thing changed (red car, snow) | Duplicate grouping, not "is it a copy" |
| `scene` | Another photo of the same place or object, from a burst or a different angle: Open Images series, Commons categories | "More like this", burst grouping |
| `class` | A different photo of the same kind of thing (another dog in a car) | Semantic search only |
| `other` | Unrelated | Nothing |

About 30 queries, each against the whole corpus (121 images plus the generated copies and edits),
so a model is scored on retrieval as well as on single pairs.

## Scoring

- **Retrieval:** for each query and level, recall@1 and recall@5 over the whole corpus, and mean
  average precision.
- **Thresholds:** the similarity cut-off that separates `copy` from everything else, and `scene`
  from `class`. A model passes a level when one cut-off separates it with at most one mistake.
- **Speed and memory:** embedding time per image and model size. Search time is negligible at
  this scale.

## Site

For each query, the top 5 matches per model with their scores, coloured by level (green: should
match, red: shouldn't). A table shows recall per level per model.

## Ties to other work

- The SigLIP/CLIP provider is shared with the sensitive-images plan (zero-shot categories).
- The `edit` level reuses the edit suite's outputs: a second use for images we already have.

## Questions for the owner

- **Q1.** Which uses matter most (duplicates, bursts, re-uploads, "more like this")? That decides
  which levels carry the score.
- **Q2.** Include DINOv3 despite its non-Apache licence, or keep to Apache/MIT models?
- **Q3.** Is a PDQ port worth it, or are pHash and dHash enough as the no-ML baseline?
