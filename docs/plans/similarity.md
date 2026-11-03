# Plan: image similarity

Status: draft for review (2026-11-03). Nothing is built yet.

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
| PDQ (Meta) | none | Perceptual hash | Built for re-upload matching; needs a port or a WASM build (check) |
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
