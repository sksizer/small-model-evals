# Plan: sensitive images

Status: built (2026-11-04). Corpus and cases (stage 1), providers, assertion, site and first runs
(stage 2) are in place. The owner's answers are under "Decisions"; the differences between this plan
and what was built are under "As built". The sections below are the original plan, kept as written.

## Goal

Measure how well small local models can say "don't let this image leave the device". That
covers explicit images, and also images that aren't nude but are still private: an ID card, a
screenshot of a chat, a child's face, a prescription, a house number. The `nudity-flag` suite
covers only the first. This suite covers the whole range, and asks for a **risk score**, not only
yes/no, so an app can pick its own threshold and keep a "review" band in between.

## Categories (to approve)

Each case is labelled with every category that applies, plus an overall level.

| Id | Category | Examples | Notes |
| --- | --- | --- | --- |
| `nudity` | Explicit nudity | Nude photos | Same rule as nudity-flag: adults only, CC0/PD |
| `intimate` | Intimate but not nude | Underwear, lingerie, bedroom shots, partial undress | Swimwear at a beach is *not* intimate (Q2) |
| `minor` | A child is identifiable | Ordinary photos with children's faces | Ordinary scenes only, never anything else (Q3) |
| `face` | An identifiable person | Close-up of a face, a person in focus | Crowds and distant figures don't count |
| `id-document` | Identity document | Passport, driving licence, ID card | Synthetic only |
| `financial` | Money details | Bank card, statement, invoice with account numbers | Synthetic only |
| `screen` | Personal data on a screen | Chat, email, notifications, a contact list | Synthetic screenshots |
| `medical` | Health information | Prescription, test result, X-ray, visible injury | |
| `location` | Where someone lives or is | House number, number plate, street sign with a home in view | |
| `credential` | Access secrets | Password on a sticky note, QR code, boarding-pass barcode, keys | |
| `document` | A private document | Letter, contract, handwritten note with names | |

**Overall level:** `public` (fine to share), `review` (a person should look), `private` (never
share without asking). The level comes from the categories: `nudity`, `id-document`, `financial`
and `credential` make an image private, and any other category puts it at least in review. The
mapping is part of the case data, so the app's policy can be changed without new cases.

## Corpus

| Source | Gives | Licence |
| --- | --- | --- |
| Synthetic pages, rendered by headless Chrome like the OCR pages (`corpus/synthetic/`) | ID cards, bank cards, statements, chat and email screenshots, prescriptions, boarding passes, letters: all with invented names and numbers | Ours |
| Open Images V7 validation, through `scripts/pick-openimages.ts` | Faces, number plates (`Vehicle registration plate`), screens (`Mobile phone`, `Laptop`, `Computer monitor`), `Medical equipment`, `Brassiere`, `Swimwear`; also ordinary scenes as negatives | CC BY 2.0 |
| Wikimedia Commons | House fronts with numbers, X-rays, prescriptions | CC0 / PD / CC BY |
| The existing nudity corpus | `nudity` positives; art and swimwear as hard negatives | CC0 / PD |
| `private/` (gitignored) | The owner's own photos, if wanted (Q5) | Never published |

The target is about 80 cases: 6–8 positives per category, and at least 25 negatives, many of them
"near misses". Examples: a blank card template, a screen showing a public web page, a clothed
portrait at a distance, a street with no readable numbers. Synthetic pages are marked as such, so
results can be split between real photos and rendered pages.

Children: only photos where a child appears in an ordinary public scene (a park, a school
sports day), from Open Images or Commons, with nothing else sensitive in the image. They're
marked `sensitive: true`, so the site covers them like the nudity images.

## Models

| Approach | Model(s) | Output | Why |
| --- | --- | --- | --- |
| Vision LLM with the category list | qwen3.5:4b, qwen3.5:9b, lfm3-vl:2b, gemma4:e4b | Per category yes/no + risk 0–1, schema-constrained | qwen3.5:4b was the best judge so far; gemma4 refused on nudity, which this measures again |
| Safety-policy VLM | LlavaGuard 1.2 0.5B | Policy verdict | Smallest safety VLM; its categories don't clearly include privacy, and it may need a runtime we don't have (check first) |
| Zero-shot image-text | SigLIP 2 base, CLIP ViT-B/16 (ONNX) | A score per category prompt ("a photo of an ID card") | Tiny and fast, and gives real scores; shared with the similarity plan |
| Existing specialists | YuNet (faces), the two NSFW ViTs, Florence-2 OCR + patterns for card numbers, emails, phone numbers and addresses | Signals | Already pinned and measured; fast |
| Composite | Specialists first, the LLM only when they're unsure | Per category + level | What an app would actually ship: cheap first, expensive second |

Llama Guard 4 has an explicit privacy category, but at 12B it doesn't fit 16 GB. It's left out
unless a bigger machine joins.

## Scoring

- **Per category:** precision and recall, at the model's own yes/no and over a threshold sweep
  where there's a score.
- **Overall level:** a missed `private` image (a leak) costs more than a false alarm. The score
  weights misses 3:1 (Q4), and the pass mark is "no private image called public".
- **Risk calibration:** where a model gives a score, the Brier score, plus the threshold that
  keeps every private case out of `public`, and how many false alarms that threshold costs.
- **Speed and memory:** per image, as in the other suites. The composite's cost is what it
  actually ran.

## Site

Covered images, as in nudity-flag. Each result shows the categories as chips (hit, missed,
false alarm), the level, and the risk scores as small bars. A suite page plots
leaks against false alarms for each model as its threshold moves.

## Order of work

1. Owner answers the questions below; the category table is fixed.
2. Synthetic page templates (one per document kind), rendered into the corpus.
3. Open Images and Commons picks: contact sheets for the owner to approve, as for regions.
4. Cases, assertion (`assertions/sensitive.ts`) and the vision-LLM provider prompt.
5. SigLIP/CLIP zero-shot provider (shared with similarity), then the composite.
6. Runs, site UI, notes.

## Questions for the owner

- **Q1.** Is the category table right? Add, merge or drop rows.
- **Q2.** Does beach or pool swimwear count as `intimate`? The plan says no, and keeps swimwear
  as a hard negative, as in nudity-flag.
- **Q3.** Include children (`minor`) at all? If yes, ordinary public scenes only, covered on the
  site.
- **Q4.** Is the 3:1 leak-to-false-alarm weight right, and is "no private image called public"
  the pass mark?
- **Q5.** Should a private (gitignored) set of your own photos join this suite? It would show
  only on the private site.
- **Q6.** Should LlavaGuard be included if it needs a Python runtime (like mflux), or only models
  that run in Ollama or ONNX?

## Decisions (owner, 2026-11-04)

- **Q1.** The category table stands, `minor` included.
- **Q2.** Swimwear is public (a hard negative, not `intimate`).
- **Q3.** `minor`: ordinary public scenes only, covered on the site.
- **Q4.** A leak (expected private, predicted public) weighs three times a false alarm. The suite's pass
  mark is no private image predicted public.
- **Q5.** No private photo set.
- **Q6.** LlavaGuard is skipped for now: its policy has no privacy category, its licence is research-only,
  and it runs only in Python. Llama Guard 4 stays out for size.

## As built

- **Corpus:** 108 cases; the `intimate` positives are six, with three added at the end (adults in
  underwear or lingerie, none nude, no Child/Boy/Girl labels).
- **Vision LLMs** (`providers/ollama-sensitive.ts`): one schema-constrained call per image,
  `{categories: {id: {present, risk}}}`, temperature 0, thinking off. The category definitions are
  `DEFINITIONS` in `assertions/sensitive-levels.ts`, shared by the prompt and the site. The reply is
  normalised to `{categories: {id: risk}, level, raw}`; a category counts at risk >= 0.5.
- **Zero-shot** (`providers/zero-shot.ts`, labels `siglip2-base-zs` and `clip-vit-b16-zs`): the pinned
  encoders of the similarity suite plus their text towers. Two to four positive prompts per category and six
  generic negatives. SigLIP: per-prompt sigmoid with the checkpoint's logit scale and bias, category risk is its
  best prompt. CLIP: softmax at scale 100 over all prompts; category risk is the best positive prompt against
  the best negative (sigmoid of 100 times the cosine gap), so 0.5 means "beats every negative". Both use fixed
  thresholds, nothing tuned on the cases; the sweep is on the suite page.
- **Composite** (`providers/sensitive-composite.ts`, label `composite-qwen3.5-4b`): YuNet, Falconsai NSFW ViT,
  SigLIP, then Florence-2 OCR plus regexes (only when a text-bearing category looks possible), then qwen3.5:4b
  only when nothing is decisive. "Decisive" is defined in the provider's header: strong evidence for a private
  category (the level cannot go higher), or no evidence at all with every signal quiet (public).
- **Scoring** (`assertions/sensitive.ts`): level from `levelOf` on both sides; error is the weighted steps
  (leak 3, false alarm 1) over the worst the case allows in that direction; the case passes when the level is
  exact. The suite's pass mark (zero leaks), per-category precision and recall and the leak-versus-false-alarm
  curve are computed in `scripts/export-site.ts`.
- **Reply cut-off:** qwen3.5:4b wrote newlines after the first key until the token cap on 5 of 108 images (a
  constrained-decoding loop). A reply cut at the cap is asked for once more with a repeat penalty of 1.2; the
  result records `retried` and counts both calls' time.
- **Site:** the suite page has the summary table, per-category recall and precision, the leak-versus-false-alarm
  curve and, for the composite, the stage use; the gallery has the covered images, expected and predicted
  categories as chips, the level against the expected one, and a risk bar per category.
- **Not done:** LlavaGuard (Q6); a Brier score and a calibrated-threshold recommendation (the sweep is shown,
  no threshold is chosen); the private set (Q5).
