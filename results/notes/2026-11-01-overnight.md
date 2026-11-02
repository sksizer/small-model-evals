# Overnight runs 2026-10-31 → 2026-11-01: notes

The second batch, on the same M4 Mac mini (16 GiB). New suites: `nudity-flag` (77 cases) and the four
region suites, `regions-objects` (14), `regions-find` (18), `regions-faces` (15) and `regions-text` (8). Also rescored or
rerun: `workout` (scorer fixes), `classify` (64-token output cap). The records are in `results/ledger/`;
these are the observations the numbers don't carry.

## Region suites

Pass means F1 ≥ 0.7, with boxes matched at IoU ≥ 0.5 and the same label (`assertions/regions.ts`).

| Model | objects | find | faces | text | per image |
| --- | --- | --- | --- | --- | --- |
| qwen3.5:4b | **12/14** | 17/18 | **13/15** | 0/8 | 3–5 s (22 s text) |
| qwen3.5:9b | 11/14 | **18/18** | 12/15 | — | 5 s |
| lfm3-vl:2b | **12/14** | 15/18 | 11/15 | 5/8 | 1–2 s |
| gemma4:e4b | 3/14 | 12/18 | 5/15 | 0/8 | 3 s (14 s text) |
| florence2-base (od / ground / ocr) | 4/14 | 14/18 | 12/15 (od) | **8/8** | 0.8 s (1.8 s ocr) |
| yunet-2023mar | | | **13/15** | | under 10 ms |
| ppocr-v5-mobile-det | | | | 6/8 | under 50 ms |
| grounding-dino-tiny | 4/14 | 12/18 | 9/15 | 0/8 | 1.2 s |
| owlv2-base | 6/14 | 11/18 | 7/15 | 0/8 | 1.5 s |
| rtdetr-r18 | 6/14 | | | | 0.1 s |
| dfine-s / dfine-n | 5/14 · 0/14 | | | | 0.1 s / under 50 ms |

- **The small vision LLMs box things well.** qwen3.5:4b and lfm3-vl:2b beat every dedicated
  detector on objects and named things. Their boxes are on a 0–1000 grid in [x0, y0, x1, y1];
  gemma4 is read as [y0, x0, y1, x1] (its documented order) and still scores poorly. The order is
  right: its boxes overlap the expected ones better as read (mean best IoU 0.39–0.59 across
  objects, find and faces) than with the axes swapped (0.17–0.33). It's genuinely weak at boxing.
- **Specialists win in their own lane:**
  - Florence-2 OCR found every text line on all 8 pages, at 0.99 F1.
  - YuNet matched the LLMs on faces in under 10 ms.
  - PP-OCR det got 6/8 in under 50 ms.
- **Text lines defeat the LLMs.** Asked for "text", they box the whole page. Asked for each
  visual line (`ask` in the config), lfm3-vl got 5/8, but qwen3.5:4b still merges or misplaces
  lines (0/8, mean F1 0.11). The open-vocabulary detectors (OWLv2, Grounding DINO) can't do text
  lines at all.
- **dfine-n is just weak.** At threshold 0.5 it returns almost nothing (F1 0.11). Rerun at 0.3
  (`dfine-n-t0.3`, 2026-11-02) it barely improves: 1/14, F1 0.16. dfine-s scores 5/14 through the same code,
  so the threshold isn't the cause.
- Fixed-class detectors (D-FINE, RT-DETR) need a label map: they use the old VOC names
  (`pottedplant`, `diningtable`, `tvmonitor`...).
- Grounding DINO only works with one joined prompt (`"dog . car ."`); a label list errors in the
  ONNX export (`join_phrases`).
- Detector timings are in-process per image after load. `rss_mb` is process memory, an upper
  bound on the model's footprint.

## nudity-flag

77 cases, split into explicit nudes (9), nude art (10), swimwear (8) and everything else (50).
Each column counts the cases judged correctly. Explicit nudes should be flagged. Nude art is
counted correct when it is not flagged. Swimwear and everything else should also stay unflagged.

| Model | nude 9 | art 10 | swim 8 | other 50 | total |
| --- | --- | --- | --- | --- | --- |
| qwen3.5:4b | 9 | 8 | 6 | 50 | **73/77** |
| vit-nsfw-falconsai | 3 | 9 | 8 | 50 | 70/77 |
| gemma4:e4b | 0 | 10 | 8 | 50 | 68/77 |
| vit-nsfw-adamcodd | 9 | 7 | 1 | 50 | 67/77 |
| d1-omni:600m | 1 | 8 | 8 | 49 | 66/77 |
| d1:2b | 9 | 6 | 0 | 50 | 65/77 |
| lfm3-vl:2b | 7 | 1 | 0 | 50 | 58/77 |

- The totals hide the important column. **gemma4 flags nothing**: 0/9 explicit nudes. That looks
  like a refusal or safety filter, not a judgement, so its 68/77 is meaningless for this job.
  Falconsai is close behind (3/9).
- qwen3.5:4b is the only model that catches every nude while mostly sparing art and swimwear.
  AdamCodd also catches every nude, but it flags 7 of 8 swimsuit photos.
- No nudity *region* suite yet. No public box data meets our sourcing rules, and NudeNet's
  detector is AGPL and trained on a scraped set. Boxes need hand-labelling on the site's
  `/label/` page.

## Rescoring and reruns

- workout: the scorer no longer gives credit for matching empty set lists, and a cardio session
  is compared on duration alone. Scores fell to their real level. gemma4 leads with 8/16; most
  models score 2–6.
- classify: lfm3:1.7b ran to the 5-minute timeout. With `num_predict: 64` it answers, but it
  labels almost everything "task" (4/20). That's a real weakness, not a harness fault.
- gemma3:4b's classify row stays stale. The output cap changed its provider config, and the
  runner now skips it under the 12-month age rule (released 2025-03). Add `baseline` to its
  registry entry to keep it.

## Harness

- Staleness is now per model. A result depends on the shared suite setup, that model's own
  provider entry, and the scorer files those reference. Previously, editing one provider file
  (`ollama-boxes.ts`) staled every detector in the same suite.

## edit (added 2026-11-02)

FLUX.2 klein 4B, 4-bit MLX build (`mflux-community/flux2-klein-4b-mflux-q4`, Apache 2.0), run by
mflux 0.24.0. It passed 9 of 10 cases, taking 35–45 s per edit (4 steps, loading included) and
peaking at about 11.5 GB of the 16 GB machine. It's the largest editor this machine can run: the
other candidates are 9–20B (Qwen-Image-Edit, FLUX.2 klein 9B, Kontext) or gated under custom
licences (FLUX 3 klein, Bria Fibo).

- The only failure is real: asked to remove a bowl, it removed it but added a cup in its place.
- The judge's yes/no answers matched what I saw on the edits I checked by eye (recolour, removal,
  title text, pencil sketch).
- Preservation outside the edit region was 3–12 out of 255. The armchair recolour came close to
  the limit (11.7 of 12) because its region covers most of the image. The limit may need
  revisiting once there are more edits.
