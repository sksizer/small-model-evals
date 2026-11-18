# Plan: prose to JSON (structured extraction)

Status: proposed (2026-11-14). Waiting on the owner's answers to the questions at the end.

## Goal

Find the smallest model that reliably turns a piece of prose into JSON that fits a given schema, with the
right values. Typical uses:
- a forwarded email becoming a calendar entry;
- a receipt's text becoming line items;
- a job post becoming a structured record;
- a voice-memo transcript becoming tasks.

The existing `extract` suite covers only part of this. It has 15 one-line notes and one fixed schema, plus
date arithmetic ("next Tuesday"). There, the best scores come from models of 4B parameters and up (qwen3.5:4b
12/15), and nothing under 2B passes more than 6.

## Models

**Dedicated extractors**, none tested yet:

| Model | Size | Licence | Runs as | Note |
| --- | --- | --- | --- | --- |
| LFM2-350M-Extract | 0.35B | LFM Open License (restricted: free below a revenue cap) | GGUF in Ollama | Smallest candidate; Sep 2025, so it needs `baseline` to pass the 12-month rule |
| LFM2-1.2B-Extract | 1.2B | LFM Open License (restricted) | GGUF in Ollama | Schema given in the system prompt; JSON, XML or YAML out; Aug 2025. **Deprecated by Liquid**, which now recommends LFM2.5-1.2B-Instruct for extraction (below) |
| LFM2.5-1.2B-Instruct | 1.2B | LFM Open License (restricted) | GGUF in Ollama | Liquid's recommended successor for extraction; general instruct model |
| NuExtract 2.0 2B | 2.2B | MIT | GGUF in Ollama | Uses a JSON *template* (types as leaf values), not a JSON Schema; text and images; May 2025 |
| NuExtract3 | 4.5B | Apache-2.0 | GGUF in Ollama (MLX builds also exist) | Newest (Apr 2026), on Qwen3.5-4B, adds OCR; the likely ceiling |
| Schemer (Desert Ant Labs) | Not stated | Desert Ant Labs source-available 1.0 (restricted) | ONNX | The schema drives decoding; its own benchmark puts it ahead of LFM2-Extract. Size and runtime to confirm (Q4) |

**General models not yet tested**, which also join every other suite they can take (owner, 2026-11-14: multimodal models run every suite, text and vision):

| Model | Size | Licence | Runs as |
| --- | --- | --- | --- |
| Gemma 4 E2B (`gemma4:e2b`) | About 5B with its encoders, roughly 2B effective | Apache-2.0 | Ollama; multimodal, so it runs every suite, text and vision |
| LFM2.5-2.6B | 2.7B | LFM Open License (restricted) | GGUF in Ollama; the generation before lfm3, July 2026 |

**Already measured, as the yardsticks:** qwen3.5:4b, gemma4:e4b, granite4.2:3b, minicpm5-2b, lfm3:1.7b,
botpsy-0.8b and qwen3.5:0.8b.

## Evidence on the older extractors

Searched 2026-11-14 for results not published by the models' makers.

- **NuExtract 2.0 2B has strong independent evidence.** VAREX ([arXiv 2603.15118](https://arxiv.org/html/2603.15118v1)) is a
  document-extraction benchmark of 16 models. It reports image-input exact match:

  | Model | Exact match |
  | --- | --- |
  | Gemini 2.5 Pro (reference) | 98.0% |
  | Qwen3-VL 8B | 96.6% |
  | **NuExtract 2.0 2B** | **90.8%**, best under 4B |
  | InternVL3.5 2B | 85.6% |
  | Qwen2.5-VL 3B | 82.5% |
  | Gemma 3n E2B | 71.0% |
  | Gemma 3 4B | 65.3% |
  | Qwen3-VL 2B | 34.2% |
  | NuExtract's base, Qwen2-VL 2B | 9.7% |

  The paper's finding is that below 4B parameters the bottleneck is following the schema, not reading the
  document. Small models "echo" the schema instead of filling it, especially when it uses `$defs`: compliance
  failures rise from 2–3% on flat schemas to 68–69%. NuExtract 2.0 2B showed no schema echo.
- **LFM2-Extract (350M and 1.2B) has no independent results.** The only numbers are Liquid's own (5,000
  documents, syntax and faithfulness scores, a claim of beating Gemma 3 27B). Liquid's documentation now lists
  LFM2-1.2B-Extract as deprecated.
- **General findings:**
  - Constrained decoding removes syntax failures in 0.6B–4B models, but a gap in getting the *values* right
    remains and grows as models shrink ([arXiv 2609.23742](https://arxiv.org/html/2609.23742v1)).
  - The Structured Output Benchmark ([arXiv 2604.25359](https://arxiv.org/html/2604.25359v1)) finds the same:
    valid JSON is nearly solved, value accuracy separates models (Schematron-8B: 98.7% valid JSON, 73.1% value
    accuracy).

What this changes in the plan:
- NuExtract 2.0 2B stays in as a baseline: independently the best small extractor, despite its age.
- LFM2.5-1.2B-Instruct joins as Liquid's recommended successor. LFM2-Extract stays only as the smallest
  extractor (350M) and the deprecated 1.2B as a yardstick.
- Some cases use schemas with `$defs`, and **schema echo** (returning the schema's shape or field descriptions
  instead of values) is scored as its own failure, so the site can show it.

## The restricted licences

Read from the licence texts on 2026-11-14.

| | LFM Open License v1.0 (LFM2-Extract, LFM2.5-2.6B, also lfm3 here) | Desert Ant Labs Source-Available 1.0 (Schemer) |
| --- | --- | --- |
| Commercial use | Free while the user's organisation, including affiliates it controls or is controlled by, has under $10M annual revenue. Above that, not licensed. Qualified non-profits are exempt for research. | Free in apps under 100,000 monthly active devices per platform, counted per model. Above that, a paid licence. |
| Research and publishing | Not restricted | Benchmarking to choose a model is expressly allowed; academic publication is allowed, with a request to cite |
| Redistribution | Allowed, with the licence and notices; modified files marked | Only inside your app. Not as a standalone model, SDK or hosted service |
| Attribution | Keep notices and the NOTICE file | "Powered by Desert Ant Labs" in an about or credits screen |
| Prohibited uses | None beyond the revenue cap | Training or distilling a competing model from it or its outputs; reverse engineering; bypassing safety models; tampering with telemetry |
| Outputs | Not addressed | Yours |
| Other | Patent licence ends if you sue over patents; ends automatically on breach | **The SDK sends telemetry to count devices**; ends on breach, with 30 days to cure a curable breach, and shipped copies keep working |

Neither stops us testing or publishing results. Both limit what someone may *ship*, so the site must say so
wherever these models are recommended. Schemer's telemetry matters for an on-device, private use. If we run
its bare ONNX weights without the SDK, we must check that this is allowed and that nothing phones home.

## Recording licence facts

Today `scripts/catalog.ts` holds one licence name and a link per model, with any limits in free text in the
notes. The plan adds structured facts per licence, kept once per licence and referenced by each model:

- `commercial`: `yes` / `conditional` / `no`, plus the condition in a few words ("under $10M annual revenue",
  "under 100k devices per platform", "non-commercial only");
- `redistribute`: `yes` / `in-app only` / `no`;
- `attribution`: what must be shown;
- `use_policy`: whether a prohibited-use policy applies, with a link (the Gemma terms, Meta's DINOv3 licence);
- `no_competing_models`: whether outputs may be used to train other models;
- `telemetry`: whether the official runtime phones home;
- `checked`: the date the text was read, and the URL.

The Model finder's "permissive licence only" switch is then computed from these facts rather than a name list.
It gains a "commercial use without conditions" filter, and each model page shows the facts as a small table.
This covers every model already here, including the Gemma terms (embeddinggemma:300m, gemma3), CC BY-NC (Jina
CLIP v2) and Meta's DINOv3 licence, not only the new ones.

## How each model is asked

Every model gets the same note and schema. What differs is how they're presented to it, using the method
its makers document, so a model isn't marked down for our prompt.

- **General models:** our system prompt plus the schema, with Ollama's `format` constraint, as `extract` does
  today.
- **LFM2-Extract:** Liquid's recommended system prompt, which names the format and gives the schema.
- **NuExtract:** the schema is converted to its template format (a small converter, tested on the suite's
  schemas), wrapped in its `# Template:` / `# Context:` prompt.
- **Schemer:** the schema passed as its documented input.

Each model runs in two modes:
- **Constrained:** Ollama's `format` forces valid JSON, so only the values are scored.
- **Native:** no constraint. Here we also count invalid JSON and replies that don't match the schema, which is
  what you get if you can't constrain decoding (on a phone, say).

## Cases: a new suite, `extract-prose`

`extract` stays as it is, so its history stays comparable. `extract-prose` has about 40 cases, each a prose
passage plus its own schema:

| Group | Cases | Prose | Schema features |
| --- | --- | --- | --- |
| Messages | 8 | Emails and chat threads arranging something | Nested contact, a date and time with time zone, optional fields |
| Receipts and invoices | 6 | OCR-style text of a receipt | An array of line items, numbers with currency, totals that must add up |
| Notes and memos | 8 | Meeting notes, voice-memo transcripts | An array of tasks with owner and due date, enums |
| Listings | 6 | Job posts, product descriptions, rentals | Numbers with units, ranges (min/max), booleans |
| Events | 6 | Announcements and invitations | A start and end, a location, recurrence |
| Traps | 6 | Prose that lacks a field, contradicts itself, or mentions two candidates | Nulls, the later correction wins, picking the right entity |

- **Length:** passages run from 50 to 400 words, with schemas from 4 to 20 fields, two levels deep at most.
- **Text:** all written here and released CC0, following the "Text corpus" rule in `docs/standards/corpus.md`.
  Names, addresses and numbers are invented.
- **Expected outputs:** written by hand and checked by a second read.

## Scoring (`assertions/extract-fields.ts`)

- **Per field:**
  - enums, ids and booleans must match exactly;
  - strings match after trimming and ignoring case, or by a field's listed alternatives;
  - numbers must fall within a stated tolerance;
  - dates are compared as dates;
  - arrays are compared as sets, scored by F1 (each item matched by its key field).
- **Case score:** the field F1 over all leaf fields. A value invented where the prose gives none (expected null)
  counts as a false positive.
- **Pass:** F1 ≥ 0.9 with no invented value.
- **Native mode also records:** valid JSON (yes/no), schema-valid (yes/no), and whether it passes.
- **Speed and memory:** per case, as in the other suites. Output tokens per second matter here, because some
  schemas produce long replies.

## Site

- **Suite page:**
  - a table of model × mode with pass rate, field F1, invented values and JSON validity in native mode;
  - per-group columns, so it's clear which kinds of prose a model handles.
- **Gallery:** each passage beside every model's JSON, with fields coloured right, wrong, missing or invented.
- **Model finder:** new tasks "Prose to JSON (constrained)" and "Prose to JSON (no constraint)".

## Order of work

1. The owner answers the questions below.
2. Licence facts in the catalogue ("Recording licence facts"), for every model, before new models are added.
3. Write the 40 cases and their schemas, and the scorer with unit tests on hand-made right and wrong answers.
4. Adapters: the NuExtract template converter, the LFM2-Extract prompt, and Schemer if it fits (Q4).
5. Pull and pin the models. Run `bun scripts/run.ts --plan` first; everything fits this 16 GB machine.
6. Runs, with the same low-load trigger as the food-lookup rerun. Then gemma4:e2b and LFM2.5-2.6B on the
   other suites.
7. Site, notes, and a short "which model for which job" summary.

## Questions for the owner

- **Q1. Restricted licences.** LFM2-Extract, LFM2.5-2.6B and Schemer are under restricted licences (see "The
  restricted licences"). The owner leans to including them, marked as restricted (2026-11-14). Confirm, and say
  whether Schemer's device telemetry rules it out.
- **Q2. Native mode.** Is the unconstrained mode worth running (it doubles the runs), or is constrained enough?
  Native matters only where decoding can't be constrained.
- **Q3. Prose domains.** Are the six groups the right mix? Add or drop any (for example health notes, or
  shopping lists from speech).
- **Q4. Schemer.** Include it only if it runs in ONNX or Ollama without extra tooling, or is it worth a Python
  runtime like mflux?
- **Q5. Older models.** LFM2-Extract and NuExtract 2.0 are over 12 months old. The evidence ("Evidence on the
  older extractors") supports keeping NuExtract 2.0 2B as a baseline. LFM2-1.2B-Extract is deprecated and has no
  independent results, so it would be a yardstick only. Keep both, or drop the deprecated one?
- **Q6. Answered (2026-11-14):** multimodal models run every suite, text and vision. Gemma 4 E2B, NuExtract 2.0 2B
  and NuExtract3 take images, so they join the vision suites too (NuExtract may do poorly outside extraction;
  that is worth knowing). LFM2.5-2.6B and LFM2.5-1.2B-Instruct run every text suite.
