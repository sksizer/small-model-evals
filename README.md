# small-model-evals

Evals of small local models for the jobs a notes or personal-data app hands them: pick a tool,
extract fields, triage an item, read the text in an image, tag a photo, and how fast and how
much memory each takes. Run with [promptfoo](https://www.promptfoo.dev) against
[Ollama](https://ollama.com) models on your own machine.

Cases never change once used and results are only ever appended, so every number traces back to
exactly what the model was asked, on what hardware and runtime. A static site
([`site/`](site/)) shows the results with sorting, search, image galleries and a corpus browser.

## Requirements

| Tool | For |
| --- | --- |
| [Bun](https://bun.sh) 1.2+ | Scripts and the site build |
| [Ollama](https://ollama.com) | The models under test |
| Node.js (for `npx`) | promptfoo, pinned to 0.125.1 |
| Chrome or Chromium | Only to render new synthetic corpus pages |
| [mflux](https://github.com/filipstrand/mflux) 0.24.0, via [uv](https://docs.astral.sh/uv/) | Only the `edit` suite; Apple silicon only |
| [ffmpeg](https://ffmpeg.org) with libopus and libx264 (`brew install ffmpeg`) | Only the audio and video corpus and, later, its suite; `scripts/setup.ts` reports it when missing |

```sh
bun install
uv tool install mflux==0.24.0   # Apple silicon, for the edit suite
bun scripts/setup.ts            # pulls the Ollama models, downloads the editor weights
bun run eval --models qwen3.5:4b
bun run site
```

`scripts/setup.ts` pulls every Ollama model the runner would run (models past the age limit are
skipped), downloads the pinned mflux weights into `.cache/models/`, and lists what is still
missing. `--dry-run` only reports; `--models a,b` limits it. ONNX models download themselves on
first use. On a machine that isn't Apple silicon, the mflux editors are skipped by setup and by the
runner.

### On another machine

Clone, run the setup above, then `bun run eval`. Each ledger record names its machine
(`machine.key`, e.g. `Mac16,10-16g`), so results from a second machine add rows rather than
replacing this one's. Commit `results/` from there and the site shows both. Expect large
downloads: the Ollama models are a few GB each, and the edit model is 4.6 GB.

Results so far come from one Apple M4 Mac mini with 16 GiB. Numbers from other machines are
recorded separately (each record names its hardware), so contributions from other hardware add
rows rather than overwrite.

## How promptfoo works

A suite is one `promptfooconfig.yaml` with three parts:

| Part | What it is | Here |
| --- | --- | --- |
| `providers` | The models, each with its call settings | Ollama tags, `temperature: 0`, `think: false` on reasoning models |
| `prompts` | Templates; `{{var}}` fills from each test | A chat message list, so the system prompt is fixed |
| `tests` | Inputs plus assertions | One file per case in `cases/`; scored by `assertions/*.ts` |

promptfoo runs every test against every provider and shows a pass/fail grid.

## Suites

| Suite | Category | Cases | Score |
| --- | --- | --- | --- |
| `perf` | all | 3 context sizes × 3 runs | Load time, prompt and output tok/s, loaded memory (custom provider, `providers/ollama-perf.ts`) |
| `perf-embed` | embed | 64-paragraph batch × 3 | Embeddings per second |
| `extract` | extract | 15 notes | JSON fields match (`format` schema enforced) |
| `workout` | extract | 16 free-form workout logs | Session fields, and every exercise with each set (reps, kg, seconds) or duration and distance; extra exercises count against; passes at 0.85 (`assertions/workout.ts`) |
| `food-lookup` | orchestrate, extract | 12 food notes | The model searches a fixed USDA database with a `search_foods` tool, then gives each food's id and grams; a food counts when its name and energy per 100 g fit, grams within a tolerance; foods the database lacks must get no id (`assertions/food.ts`) |
| `route` | classify (routing) | 18 captured items | Which handler takes the item and whether it needs a larger model; decision models (Liquid d1) answer with probabilities through Ollama's decision endpoint, chat models with the reply limited to the options (`providers/ollama-decide.ts`, `assertions/decide.ts`) |
| `nudity-flag` | look (privacy) | 77 corpus images: 9 adult nudes, 10 nude artworks and 8 swimwear photos (CC0 or public domain), plus 50 ordinary photos | Flag a photo that shows nudity (art and swimwear are not flagged); dedicated ONNX classifiers (`providers/image-classifier.ts`), d1 and vision chat models compared on one scorer (`assertions/decide.ts`) |
| `sensitive` | look (privacy) | 108 corpus images: synthetic ID cards, bank cards, statements, chats, prescriptions and notes, Open Images faces, children, plates, screens and underwear, nude photos and art, and ordinary scenes as negatives | Say whether an image should leave the device: which of 11 categories it shows (nudity, intimate, minor, face, id-document, financial, screen, medical, location, credential, document) and so its level (`public`, `review`, `private`); a private image called public is a leak (weighs 3:1 against a false alarm), and the pass mark is no leaks. Vision chat models, SigLIP 2 and CLIP zero-shot, and a composite of specialists with a small LLM as the fallback (`providers/ollama-sensitive.ts`, `providers/zero-shot.ts`, `providers/sensitive-composite.ts`, `assertions/sensitive.ts`) |
| `orchestrate` | orchestrate | 15 requests, 5 tools | Right tool (half), right arguments (full); 3 need no tool |
| `classify` | classify | 20 items, 5 labels | Exact label |
| `ocr` | ocr, look | 8 synthetic pages and 2 printed tickets from `corpus/` | Share of visible strings read back; passes at 75% |
| `tag-image` | look | 42 photos and scans from `corpus/` | Share of expected concepts tagged (synonyms count), minus a quarter per wrong tag; passes at 60% with no wrong tag (`assertions/tags.ts`) |
| `regions-objects` | look (regions) | 14 Open Images photos | Box everyday things (dogs, cups, laptops, chairs); boxes match at IoU 0.5, F1 of precision and recall, passes at 0.7 (`assertions/regions.ts`) |
| `regions-find` | look (regions) | 18 Open Images photos | Box one named thing a fixed-class detector does not know (whiteboard, sunglasses, envelope) |
| `regions-faces` | look (regions, privacy) | 15 Open Images photos, 3 with no face | Box every face; any face box on a no-face photo is wrong |
| `regions-text` | look (regions) | 8 synthetic pages, 143 lines | Box every line of text; the boxes are measured from the page layout (`scripts/text-boxes.ts`) |
| `edit` | edit | 10 Open Images photos and synthetic pages | Change the image as instructed (recolour, remove, add, weather, time of day, style, text); a judge answers yes/no questions about the edit, and outside the allowed region the image must stay close to the original (`providers/mflux-edit.ts`, `assertions/edit.ts`) |
| `similarity` | look (likeness) | 29 query photos ranked against a pool of 153 candidates | Rank the pool by likeness to the query: is a candidate a `copy` (resized, recompressed, cropped, flipped, brightened), an `edit` (our edit suite's output), the same `scene`, the same `class` of thing or `other`? pHash and dHash against DINOv2, DINOv3, SigLIP 2 and CLIP image encoders and the image side of EmbeddingGemma 2, a nomic text+vision pair and Jina CLIP v2; scored by average precision over copy, edit and scene, with recall@1 and @5 per level (`providers/image-embed.ts`, `assertions/similarity.ts`) |
| `search` | find | 89 queries: 25 over 78 photos, 24 over 44 synthetic pages (read as images), 15 over 1500 USDA foods, 25 over 60 invented notes | Rank a corpus for a typed query: which photo, page, food or note answers it? EmbeddingGemma 2 (text and vision, one space) against SigLIP 2, CLIP B/16, a nomic text+vision pair, Jina CLIP v2 (CC BY-NC, restricted), and the text embedders EmbeddingGemma 1 (Gemma terms, restricted), Qwen3-Embedding 0.6B and nomic-embed-text; scored by nDCG@10, passes at 0.7, with recall@1/5/10 and MRR kept (`providers/search.ts`, `assertions/search.ts`) |

The regions suites compare small non-LLM detectors run in-process: fixed-class (D-FINE, RT-DETR),
open-vocabulary (OWLv2, Grounding DINO), Florence-2, OpenCV's YuNet face detector and PaddleOCR's
text detector (`providers/region-detector.ts`, `providers/florence2.ts`,
`providers/onnx-detector.ts`); vision chat models can box through `providers/ollama-boxes.ts`.
`docs/research/regions.md` has the model and dataset survey with licences. To add a regions case
by hand, draw it on the site's `/label/` page (any corpus image) and save the YAML it gives into
the suite's `cases/`. Nudity regions (boxes to blur) have no public data under a usable licence;
they wait on hand-drawn cases.

The `similarity` suite ranks a pool of candidate images by likeness to a query photo, with no Ollama: the
perceptual hashes (pHash, dHash; plain code over `sharp`, the no-ML baseline) and ONNX image encoders run
in-process (`providers/image-embed.ts`). A case lists, as candidate ids in `suites/similarity/pool.yaml`, which
candidates are `copy`, `edit`, `scene` or `class` matches for its query; every other candidate in the pool is
`other`. The `copy` candidates are committed corpus images made with `sharp` (`scripts/recipes.ts`; two per query,
derived entries in `corpus/sources.yaml` that keep their parent's credit), so their bytes never move; `edit`
candidates are the edit suite's saved outputs; `scene` candidates are photos of the same trail, car or race;
`class` groups are written by hand in `scripts/pick-similarity.ts`, which also writes the pool and the cases.
Only non-sensitive photos are used. The score is average precision over the copy, edit and scene items (class
is reported, not scored); recall@1 and @5 per level (with the stronger levels set aside, so `edit` recall is measured once the copies are out of the way), the share of unrelated images in the top five and a per-case
best cut-off are kept in each result for the site's gallery and its recall table. DINOv3 is under Meta's custom
DINOv3 licence, not Apache or MIT; its catalogue entry says so.

The `search` suite (plan: `docs/plans/search.md`) measures retrieval with embedding models, in three kinds of case (`metadata.kind`): `photos` (text to photos: object queries scored from Open Images annotations, descriptive ones by eye), `docs` (text to the synthetic pages, searched as images, no OCR) and `text` (USDA foods by a rule on the name, and invented CC0 notes). Image to image is the `similarity` suite's job; the text+image embedders are providers there too (`providers/similarity-search.ts`). A provider embeds the corpus once per run (`corpora.yaml`) and ranks it per query, with each model's documented prefixes; `kinds` in a provider's config limits it to the inputs it can take, and `scripts/run.ts` runs one eval per kind. EmbeddingGemma 2 runs q8 (its card warns off float16) with the audio encoder never loaded, and also records nDCG@10 at 256 dimensions. Two rivals are restricted (Jina CLIP v2: CC BY-NC 4.0; EmbeddingGemma 1: Gemma terms): marked in the catalogue and left out by the finder's permissive-licence filter.

The `sensitive` suite (plan: `docs/plans/sensitive.md`) asks for a risk per category and derives the overall level
from the categories in one place, `assertions/sensitive-levels.ts` (the policy, the category definitions the prompt
and the site share). A case lists only the categories its image shows. Three kinds of candidate run: vision chat
models rating every category in one schema-constrained call; SigLIP 2 and CLIP scoring category prompts against
generic negatives (the text towers run once per run, fixed thresholds, nothing tuned on the cases); and a
composite that runs YuNet, an NSFW ViT, SigLIP and Florence-2 OCR with regexes first and calls qwen3.5:4b only
when none of them is decisive (the rule is in the provider's header, and each result records which stages ran).
The suite page shows leaks, false alarms, per-category recall and precision, and a curve of leaks against false
alarms over the risk threshold, all computed in `scripts/export-site.ts`. Nudity, intimate and child images are
covered on the site. LlavaGuard is not run (no privacy category, research-only licence, Python only).

The `edit` suite hands an image editor a corpus image and an instruction. The editor is FLUX.2 klein 4B
(4-bit MLX build) run by the [mflux](https://github.com/filipstrand/mflux) CLI, one process per case that exits
when done; the weights are read from `.cache/models/<repo>/<revision>` and never downloaded by the suite. Each
edited image is saved as a JPEG under `results/edits/` (committed) for the site's gallery. A case lists
`changed` questions (must be yes after the edit), `kept` questions (must still be yes) and, where the edit is
local, a `region` (fractions of the image). An Ollama vision model (`qwen3.5:4b`, unloaded right after each
answer so it is never in memory with the editor) answers each question about the edited image. Where there is a
region, the mean per-pixel difference from the original outside it must be at most 12 of 255. The score is the
mean of the answers and the preservation check; a case passes only when every question is yes and the image is
preserved. Time and peak memory of each edit are recorded as `edit_ms` and `peak_mb`.

All cases are synthetic or from public-licence images. Cases built from your own notes or photos
go in `private/`, which git ignores:

```sh
bun scripts/init-private.ts nudity-flag              # private/suites/nudity-flag with the public config
EVALS_SCOPE=private bun run eval --suites nudity-flag
```

With `EVALS_SCOPE=private`, snapshots, the ledger, raw output and the summary go to
`private/results/`. The site export refuses that scope, so private images and replies never reach
the published site.

## Image corpus

`corpus/` holds images for the vision suites, from three sources:

| Source | What | Rules |
| --- | --- | --- |
| Wikimedia Commons | 42 photos and scans (food, pets, objects, scenes, outdoor, handwriting, documents) and 27 for nudity flagging (adult nudes, nude art, swimwear) | CC0, public domain or CC BY only (no share-alike); no personal details such as real addresses or account numbers; people as subjects only in the nudity set, which is CC0 or public domain, adults only, with no vintage or ethnographic nude photos |
| Open Images (validation) | 44 photos for the regions suites, with the dataset's own boxes | CC BY 2.0 photos, CC BY 4.0 boxes; re-encoded at 768 px with all metadata (EXIF, GPS) dropped; picked by `scripts/pick-openimages.ts` after a contact-sheet review: no children, public figures, intimate or medical scenes |
| Synthetic | 8 receipts, forms, labels and app screens, written as HTML in `corpus/synthetic/` and rendered once to PNG | Every name, address and number invented; released CC0 |

An entry marked `sensitive: true` (nudity, including in art) is shown covered on the site until
the viewer clicks "Let me view"; the page holds no address for it until then.

| File | What |
| --- | --- |
| `corpus/sources.yaml` | The list: a permanent id, a category, and a Commons file title, an Open Images id, or a synthetic page and size. Edit this to extend. |
| `corpus/images/<id>.jpg`, `.png` | A 768 px rendition, or the rendered synthetic page. |
| `corpus/manifest.json` | Per image: source page, author, licence, licence URL, size, sha256. |
| `corpus/ATTRIBUTIONS.md` | Generated credits (CC BY requires them). |

To add images, add entries to `sources.yaml` and run `bun run corpus`. It handles only new ids,
re-checks each licence (Commons against the allow-list, Open Images against its image list) and
refuses anything else. Images are immutable like cases: `check:evals` fails if a file's bytes no longer match the manifest. Replace an image by
adding it under a new id.

A tag-image case lists `expected` concepts, each one tag or a list of synonyms, and `absent` tags
that would be wrong for the image. A model tag matches when a synonym's words appear in it, so
"sleeping dogs" matches `dog`.

## Audio and video corpus

`corpus/audio/<id>.ogg` (16 kHz mono Opus: sounds 5-30 s, speech 60-120 s) and `corpus/video/<id>.mp4` (360p H.264,
5-15 s, no sound track) are the clips for the planned audio and video search suite (`docs/plans/av-search.md`). The
rules are the "Audio and video" section of `docs/standards/corpus.md`: Wikimedia Commons sounds and videos, and
LibriVox readings (public domain, checked per item on archive.org). `corpus/av-sources.yaml` lists them (id, kind,
category, source, and the `start`/`duration` segment; speech also has a `summary` and, where the book text matched,
an approximate `transcript`); `bun run corpus` converts them with ffmpeg, writes `corpus/av-manifest.json` (licence,
length, size, sha256) and adds them to `ATTRIBUTIONS.md`. `bun scripts/build-av-contact.ts` writes the contact sheet
`results/contact/av-corpus.html` for review. Freesound is allowed by the standard (CC0 only) but not fetched: its API
needs a key.

## Food database

`suites/food-lookup/foods.jsonl` is USDA FoodData Central's SR Legacy release (April 2018, public
domain): 7,793 foods with energy per 100 g and household portions. `bun scripts/build-foods.ts`
rebuilds it from the pinned download. The suite's provider (`providers/ollama-food-agent.ts`) checks
the file's sha256 against its config before every case, so the database cannot change under a
snapshot. `providers/food-search.ts` is the search the model calls: keyword ranking, no model behind
it. Try it with `bun providers/food-search.ts rice white cooked`.

## Cases are immutable

A run and the cases it used never change, so every result can be traced to exactly what the model
was asked and what counted as right.

| What | Where | Rule |
| --- | --- | --- |
| A case | `suites/<suite>/cases/<id>.yaml` | The file name is `metadata.id`. Once a run uses it, its content never changes. |
| A retired case | `suites/<suite>/cases/retired/<id>.yaml` | Not run any more; kept so old results resolve. |
| A suite snapshot | `results/suites/<suite>/<fingerprint>.json` | Written by the runner the first time a suite version runs: the setup (config without its test list, referenced files, scoring code) and every active case. Never edited. |
| A result | `results/ledger/<suite>.jsonl` | Lines are only added. Each names its snapshot by `suite_fp` and its environment by `env`. |
| An environment | `results/environments/<hash>.json` | Hardware (chip, CPU and GPU cores, memory, Metal GPU budget), OS, power, and runtime (Ollama version and server settings from its log, promptfoo, Bun, Node). Written once per distinct environment. |
| A model build | `results/models/<digest>.json` | Engine (llama.cpp or MLX), format, quantization, parameters, context length, capabilities, default sampling. Written once per build. |

To evolve a case, add a new file with a new id and `metadata.supersedes: <old id>`, then move the
old file to `cases/retired/` and set `metadata.retired` to the reason. Content is hashed parsed,
with referenced files (images, inputs) hashed by content, so comments and layout never count.

`bun run check:evals` (also run in CI) fails on an edited or
missing used case, a snapshot that no longer matches its name, a record whose snapshot is missing,
a changed committed ledger line, and a corpus image that no longer matches its manifest hash.

## Run

```sh
bun run eval                                         # every model, every suite
bun run eval --models qwen3:4b --suites extract      # a subset
bun run view                                         # promptfoo's grid in the browser
```

`scripts/run.ts` runs one promptfoo eval per model and suite, unloading the model before each.
promptfoo itself cycles through providers inside each test, which would swap models on every call.

## Results

| Path | What | Committed |
| --- | --- | --- |
| `results/ledger/<suite>.jsonl` | One line per scored case, appended by every run | Yes |
| `results/suites/<suite>/<fp>.json` | Frozen suite snapshots the records link to | Yes |
| `results/summary.md` | Latest result per machine, model and suite, built from the ledger | Yes |
| `results/notes/<run>.md` | Observations about a run that the numbers do not carry | Yes |
| `results/runs/<run>/` | promptfoo's raw output | No |

A ledger record names what produced it: the machine (hardware model and memory), the Ollama and
promptfoo versions, the model tag and digest, the snapshot it ran against and the case id, with
the model's whole reply. See `LedgerRecord` in `scripts/ledger.ts`.

The summary keeps, per case, the newest result that ran against the current setup. A model's
results go **stale** when something they depend on changes: the prompt or shared settings, that
model's own provider entry, or a scorer file the suite uses. Adding another model or an unrelated
scorer leaves them current. A new case shows as **not run** for each model until it runs.

- **Add a model:** add it to `scripts/models.ts` and a provider with the same label to each suite
  it can run, then `bun run eval --models <label>`.
- **Add a case:** add `suites/<suite>/cases/<id>.yaml` with a new id, then rerun the suite.
- **Add a suite:** a new folder under `suites/` with a `promptfooconfig.yaml` whose `tests` is
  `file://cases/*.yaml`.
- **Import old output:** `bun scripts/import.ts results/runs/<run>` (same machine, models and
  suites; every case must carry its id).

## Results site

`site/` is a static Astro site over the ledger: a leaderboard per machine, every scored case with
search, filters and sorting, a case-by-model grid per suite, a gallery for suites whose cases are
images (each image beside every model's found and missed strings or tags), a case index (every
case in every suite with its input, expected answer and models passing), a corpus browser
(sensitive images blurred until you click "Let me view"), a
field-by-field comparison for extraction results, a page per model with its engine, failures and history, speed and memory, and
the run list with each run's environment. Filters stay in the URL, so a filtered view can be
shared.

```sh
bun run site            # dev server with live reload
bun run site:build      # public build in site/dist
bun run site:build:all  # public and private builds
bun run site:private    # private build, served on http://127.0.0.1:4400 only
```

`scripts/build-site.ts` runs `scripts/export-site.ts` and then `astro build` for each scope. The
public export writes `site/src/data/evals.json` from the ledger and copies the corpus images into
`site/public/`. The site reads only that file.

The private build shows everything at once: every public suite plus the suites under `private/`
(your own notes and photos, the private nudity set), listed as `private-<suite>`. Its data, images
and build all go under `private/site/`, which is gitignored, so nothing private reaches `site/` or
GitHub Pages. Its header says "private · local only", and `--serve` binds to localhost, never the
network.

`.github/workflows/site.yml` checks every push and pull request (typecheck, `check:evals`, site
build) and deploys `main` to GitHub Pages, with `SITE_BASE` set to the repository path.

## Expected values

Expected values can be a literal, a list of acceptable values, `{contains: …}`, `{startsWith: …}`
or `{approx: n, tol: t}` (see `assertions/match.ts`).

## Licence

Code: MIT ([LICENSE](LICENSE)). Corpus images keep their own licences; see
[`corpus/ATTRIBUTIONS.md`](corpus/ATTRIBUTIONS.md).
