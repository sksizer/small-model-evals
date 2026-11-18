# Plan: image generation

Status: proposed (2026-11-15). Waiting on the owner's answers to the questions at the end.

## Goal

Measure how well image generators that run on a 16 GB Mac follow a prompt, centred on **Qwen-Image-2.1**
(the owner's pick), against the open alternatives. What matters for local use is how faithful the image is to
the prompt (objects, counts, colours, positions, legible text), how long each image takes, and peak memory.
Artistic beauty isn't scored: no small judge can score it reliably.

## Models

All run through mflux 0.24 (already installed for the edit suite), 4-bit, at 1024×1024 unless a model needs
otherwise:

| Model | Size | Licence | mflux | Steps | Note |
| --- | --- | --- | --- | --- | --- |
| Qwen-Image-2.1 | 7B image model + Qwen3-VL text encoder | **Qwen Research License: non-commercial only** (restricted) | `mflux-generate-qwen-2.1` | 40 (card) | The model under test; strong typography claimed; Sep 2026 |
| Qwen-Image-2.1-Turbo | Same, distilled | Qwen Research License (restricted) | Via `--model` with `--base-model qwen-image-2.1` (to confirm) | Few | Same model, fewer steps: the speed trade-off |
| Z-Image-Turbo | 6.2B | Apache-2.0 | `mflux-generate-z-image-turbo` | 8 | Strongest open small generator we know of; Nov 2025 (needs `baseline`) |
| ERNIE-Image-Turbo | 8.0B | Apache-2.0 | `mflux-generate-ernie-image-turbo` | Few | Apr 2026; may be tight on memory |
| FLUX.2 klein 4B | 4B | Apache-2.0 | `mflux-generate-flux2` | 4 | Already pinned for edit; the smallest |

**Memory:** Qwen-Image-2.1 at 4-bit should be near this machine's budget, as FLUX.2 klein is (11.5 GB peak).
`run.ts --plan` decides once it has a measurement. mflux's `--low-ram` is used if needed, and the result says so.

**Editing too:** Qwen-Image-2.1 is a unified generation and editing model (`mflux-generate-qwen-2.1-edit`), so it
also joins the existing `edit` suite as FLUX.2 klein's first rival there.

## Cases: a new suite, `generate`

About 40 prompts written here (CC0), each with a checklist the judge answers yes or no:

| Group | Cases | Example prompt | Checked |
| --- | --- | --- | --- |
| Objects and attributes | 8 | "a red bicycle leaning on a blue door" | Each object present; each colour right |
| Counting | 6 | "exactly three green apples on a white plate" | Count; colour |
| Positions | 6 | "a cat to the left of a lamp, a book under the lamp" | Each relation |
| Text in the image | 8 | "a shop sign that reads OPEN 24 HOURS" | OCR reads the exact words (case-insensitive) |
| Styles | 6 | "a lighthouse, as a pencil sketch" | Medium and subject |
| Scenes | 6 | Longer descriptive prompts (40–80 words) | 4–6 details from the prompt |

**Content rules:** no real people or likenesses, no brands or logos, nothing sensitive. Generated images are
committed only if the owner agrees (Q3). Otherwise they stay local, like the private site.

**Fixed settings:** seed 42, one image per prompt per model. Each model's own recommended steps and guidance,
recorded with the result.

## Scoring (`assertions/generate.ts`)

- **Checklist:** a vision LLM answers each item yes or no (qwen3.5:4b, as the edit suite's judge does, or
  qwen3.5:9b; Q2). The case score is the share answered yes.
- **Text cases:** Florence-2 OCR, which read text lines perfectly in regions-text, must find the requested words.
  OCR and the judge are both recorded.
- **Pass:** every item yes, and for text cases the OCR match.
- **Judge sanity check:** the judge is also asked the checklist about a *different* case's image, which should
  get mostly "no". A judge that says yes to everything shows up there.
- **Speed and memory:** seconds per image (load counted separately) and peak memory, as for edit. Under load
  conditions, flagged.

## Site

- **Gallery:** each prompt with every model's image, the checklist coloured per model, the OCR reading, and the time.
- **Suite page:** a table of model × group pass rates, seconds per image and peak memory.
- **Model finder:** a new task, "Image generation".

## Order of work

1. The owner answers the questions below.
2. Write the prompts and checklists, and the scorer with the judge sanity check.
3. A provider (`providers/mflux-generate.ts`, alongside mflux-edit.ts) for the five generators. Pin weights in
   `scripts/models.ts`; `setup.ts` downloads them.
4. `run.ts --plan` for memory, then the runs, queued for a quiet machine (`queue.ts`).
5. Qwen-Image-2.1 on the edit suite.
6. Site and notes.

## Questions for the owner

- **Q1. Rivals.** All five, or a subset? Each takes roughly 20–60 s per image at 1024×1024, so 40 prompts is
  15–40 minutes per model.
- **Q2. Judge.** qwen3.5:4b (the edit judge, fast) or qwen3.5:9b (better, but needs CPU offload here)?
- **Q3. Publishing images.** Commit the generated images so the public site shows them? Qwen-Image-2.1's research
  licence covers use for evaluation; check whether it lets us publish its outputs, or keep those local.
- **Q4. Resolution.** 1024×1024 for all, or each model's native size (Qwen-Image-2.1's card uses 2048×2048,
  which may not fit in memory)?
