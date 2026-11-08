# Plan: search (retrieval with embedding models)

Status: built (2026-11-05): `suites/search`, `providers/search.ts`, `assertions/search.ts`,
`scripts/pick-search.ts`; the text+image embedders are also providers of `similarity`
(`providers/similarity-search.ts`). Made harder and larger on 2026-11-08 (see "The hard set" below).

## Goal

Measure how well small embedding models find the right thing for a typed query, centred on EmbeddingGemma 2
(Apache-2.0, 740M: 270M text, 170M vision, 300M audio, one 768-d space), against the open and the restricted
rivals. Three kinds of case in one suite, each tagged `metadata.kind` (`photos`, `docs`, `text`); image to
image is the `similarity` suite's, where the multimodal models are added as providers.

## What was built, and why

- **One suite, three kinds.** Cases are `photos-*` (text to non-sensitive photos), `docs-*` (text to the 44
  synthetic pages, searched as images, no OCR) and `text-*` (USDA SR Legacy foods and invented notes). Counts
  are in "The hard set". A provider lists the `kinds` it can take in its config; `scripts/run.ts`
  runs one promptfoo eval per kind with `--filter-metadata kind=...`, so a text-only model never gets a photo
  case (and shows no "not run" gap on the site, which counts only the cases a model takes).
- **Corpora live in the suite's setup** (`corpora.yaml`, inlined once into each snapshot), not in each case:
  a case names its corpus and its relevant ids. Nothing sensitive is searched (`scripts/check.ts` fails if a
  corpus lists a `sensitive` image).
- **Relevance.** Photos: 13 object queries ("a dog", "a bicycle", "a laptop") take Open Images V7 annotations
  (image-level labels at confidence 1, plus boxes) for the `oi-*` photos, extended by eye for the Commons
  photos Open Images does not cover; 12 descriptive queries ("two dogs looking out of a car window") were judged
  by eye. Open Images labels are sparse, so an object query is only as complete as the annotation. Docs: by eye.
  Foods: a regular expression on the name (in `scripts/pick-search.ts`; a case lists every food in the
  database the rule matches). Notes: judged by reading, many paraphrases ("teeth cleaning appointment" for a
  note that says "Dentist").
- **Scoring** (`assertions/search.ts`): nDCG@10 per query, passing at 0.7 (a lone relevant item at rank 1 scores
  1.0, at rank 2 0.63, at rank 3 0.5: the answer must be first or nearly), with recall@1/5/10 (capped at
  min(k, relevant) so one slot cannot be blamed for six relevant items) and MRR in the metadata.
  EmbeddingGemma 2 also records nDCG@10 at 256 dimensions (the card's MRL truncation, re-normalised).
- **Prefixes** are each model's documented ones: EmbeddingGemma 2 (and 1) `task: search result | query: `
  and `title: {title|none} | text: `, none for images; nomic `search_query: ` / `search_document: `;
  Qwen3-Embedding's `Instruct: ...\nQuery:` on queries only; Jina CLIP v2's retrieval prefix; SigLIP lowercased
  and padded to 64 tokens.

## The hard set (2026-11-08)

The best models sat at the ceiling (nDCG@10 0.95 to 0.99), so the suite could not tell strong from strong.
Every kind got a larger corpus, near-miss distractors and more queries. Cases are immutable, so the original
cases stay as they were and the new ones are new ids; the site splits each kind's score into "original" and
"hard" (`scripts/search-sets.ts` names the hard ids).

| Kind | Added | Corpus |
| --- | --- | --- |
| `text`, foods | 48 queries `text-food-*`: the 15 old queries again over the whole database (their old cases are in `cases/retired/`, superseded), then whole against low-fat and reduced-fat milk, raw against cooked and with against without skin (broccoli, carrots, apples, eggs, chicken), negations (unsalted, unsweetened, decaffeinated, no salt added, low sodium), paraphrases (aubergine, courgette, rocket, icing sugar, spring onions, tinned chickpeas) | all 7,793 SR Legacy foods, not a 1,500 subset. Each rule counts every match in the database: 1 to 16 relevant foods per query |
| `text`, notes | 18 queries `text-note-*`: each has a look-alike (a lentil salad for the soup, Madrid for Portugal, a car service for a car rental, an optician for a dentist, a plant sale for plant care) or is a paraphrase or a negation ("a cold lentil dish, not a soup") | 88 notes: the 60 originals plus 28 hard distractors n61 to n88 in `notes.yaml`, invented, CC0. None answers an original query (checked by reading) |
| `photos` | 65 queries `photos-dup-*`: the 13 object queries again (copies count as relevant), 40 fine-grained descriptions against another photo of the same kind (a black-dial watch against a white-dial one, a dog in a bed against a dog on paving), and 12 on counts, relations, categories and negation ("an animal that is not a dog", "a laptop and a notebook on a desk") | `photos-dup`: the 78 photos plus the 54 derived copies (resized, cropped, flipped, brightened, recompressed) of them from the similarity suite's corpus. No sensitive image is added |
| `docs` | 26 queries `docs-fine-*` that describe a page's content ("rent paid in October", "a blank ID card template with no personal data", "a summer sale newsletter"), judged from each page's HTML source | the same 44 pages: the near-misses (a blank template, a public timetable, a marketing email) were already in it |

The foods were re-issued as new cases because the relevant sets changed with the corpus. The old food cases
over the subset were retired, not edited. Moving a case to `cases/retired/` sets `metadata.retired`, which
`scripts/ledger.ts` leaves out of the case's hash, so the snapshots that used it still match.

### Result (2026-11-08, apple-16g, nDCG@10; all cases of the kind, then the hard set alone)

| Model | Photos (90) | Docs (50) | Text (91) |
| --- | --- | --- | --- |
| embeddinggemma2 | 0.936 (hard 0.947) | **0.988** (0.986) | **0.900** (0.868) |
| embeddinggemma2-text | | | 0.894 (0.859) |
| embeddinggemma:300m | | | 0.892 (0.873) |
| siglip2-base | **0.957** (0.961) | 0.969 (0.950) | |
| jina-clip-v2 | 0.924 (0.930) | 0.922 (0.907) | 0.780 (0.731) |
| nomic-embed-v1.5-pair | 0.915 (0.921) | 0.850 (0.769) | 0.808 (0.776) |
| clip-vit-b16 | 0.901 (0.913) | 0.927 (0.938) | |
| nomic-embed-text | | | 0.808 (0.776) |
| qwen3-embedding:0.6b | | | 0.794 (0.740) |

Against the 2026-11-05 numbers (all original cases) the best text score fell from 0.974 to 0.900 and the spread
among text models widened from 0.09 to 0.12 (0.78 to 0.90); the docs spread went from 0.075 to 0.14 (0.85 to
0.99) and nomic's pair now fails 12 of the 26 fine-grained pages. What did not get harder is photos: the hard
photo queries score the same as the original ones (0.91 to 0.96 against 0.87 to 0.95), because a descriptive
query that names a distinctive thing is still easy for an image-text model even with near-duplicates and other
photos of the same kind in the corpus. The photo spread is 0.90 to 0.96. What fails there is not the fine-grained descriptions (the only ones that
more than two models miss are "an animal that is not a dog", which all five photo models fail (they return dogs), and the
many-relevant object queries "a houseplant", "a person", "a bicycle helmet", in both the old and the copy
corpus). A harder photo kind would need many more photos or attributes the encoders do not carry, not more
queries on this corpus.

Two caveats. Most of the food failures are paraphrases and near-misses: "rocket leaves" (7 of 7 models miss
the entry named Arugula), "plain white flour", "icing sugar", "red capsicum", the roasted chicken breast with and
without skin (7 of 7, the entries differ by two words), and whole, skim and low-fat milk (2 to 4 each). The same
inputs also do not always give the same score:
embeddinggemma2 on photos scored 1.0 on `photos-wine-glass` on 2026-11-05 and 0.0 on both runs of 2026-11-08
(one relevant photo, so one rank decides it), which moved its original-photo mean from 0.948 to 0.908; read
differences of a few points as ties, as before.

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

- Small image corpora (78 photos, 132 with copies, 44 pages): many queries have one or two relevant items, so a
  single ranking flips a score; read differences of a few points as ties. After the hard set the text and
  document kinds separate strong from strong; the photo kind is still near its ceiling for the best models.
- Open Images labels are sparse; "a person" in particular depends on which classes were annotated.
- Times are per item embedded in one run of one machine; the SigLIP/CLIP memory figures include both towers.
