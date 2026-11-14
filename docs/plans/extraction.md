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
| LFM2-1.2B-Extract | 1.2B | LFM Open License (restricted) | GGUF in Ollama | Schema given in the system prompt; JSON, XML or YAML out; Aug 2025 |
| NuExtract 2.0 2B | 2.2B | MIT | GGUF in Ollama | Uses a JSON *template* (types as leaf values), not a JSON Schema; text and images; May 2025 |
| NuExtract3 | 4.5B | Apache-2.0 | GGUF in Ollama (MLX builds also exist) | Newest (Apr 2026), on Qwen3.5-4B, adds OCR; the likely ceiling |
| Schemer (Desert Ant Labs) | Not stated | Desert Ant Labs source-available 1.0 (restricted) | ONNX | The schema drives decoding; its own benchmark puts it ahead of LFM2-Extract. Size and runtime to confirm (Q4) |

**General models not yet tested**, which also join the other text suites:

| Model | Size | Licence | Runs as |
| --- | --- | --- | --- |
| Gemma 4 E2B (`gemma4:e2b`) | About 5B with its encoders, roughly 2B effective | Apache-2.0 | Ollama; vision too, so it also joins the vision suites |
| LFM2.5-2.6B | 2.7B | LFM Open License (restricted) | GGUF in Ollama; the generation before lfm3, July 2026 |

**Already measured, as the yardsticks:** qwen3.5:4b, gemma4:e4b, granite4.2:3b, minicpm5-2b, lfm3:1.7b,
botpsy-0.8b and qwen3.5:0.8b.

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
2. Write the 40 cases and their schemas, and the scorer with unit tests on hand-made right and wrong answers.
3. Adapters: the NuExtract template converter, the LFM2-Extract prompt, and Schemer if it fits (Q4).
4. Pull and pin the models. Run `bun scripts/run.ts --plan` first; everything fits this 16 GB machine.
5. Runs, with the same low-load trigger as the food-lookup rerun. Then gemma4:e2b and LFM2.5-2.6B on the
   other suites.
6. Site, notes, and a short "which model for which job" summary.

## Questions for the owner

- **Q1. Restricted licences.** LFM2-Extract, LFM2.5-2.6B and Schemer are under restricted licences. Should they
  be included and marked as restricted, as was done for search?
- **Q2. Native mode.** Is the unconstrained mode worth running (it doubles the runs), or is constrained enough?
  Native matters only where decoding can't be constrained.
- **Q3. Prose domains.** Are the six groups the right mix? Add or drop any (for example health notes, or
  shopping lists from speech).
- **Q4. Schemer.** Include it only if it runs in ONNX or Ollama without extra tooling, or is it worth a Python
  runtime like mflux?
- **Q5. Older models.** LFM2-Extract and NuExtract 2.0 are over 12 months old. Should they be kept as baselines
  (dedicated extractors age slowly, as the NSFW classifiers do)?
- **Q6. Gemma 4 E2B and LFM2.5-2.6B.** Run them on every text suite (and the vision suites for E2B), or on
  extraction only?
