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
missing. `--dry-run` only reports; `--models a,b`, `--category` and `--profile` limit it. ONNX models download themselves on
first use. On a machine that isn't Apple silicon, the mflux editors are skipped by setup and by the
runner.

### On another machine

Clone, `bun install`, then:

```sh
bun scripts/run.ts --plan       # what would run here, and which models fit this machine's memory
bun scripts/setup.ts            # pull only the models that plan keeps
bun run eval                    # run it
```

Each ledger record names its machine: `machine.key` (e.g. `Mac16,10-16g`) groups results, so a
second machine adds rows rather than replacing the first's, and `machine.class` says what size of
machine it is. Commit `results/` from there and the site shows both, never pooled.

**Machine class** is the accelerator plus a memory tier: `apple-16g`, `apple-32g`, `apple-64g+`,
`nvidia-24g`, `cpu-32g`. Apple silicon is tiered by unified memory, an NVIDIA card (read with
`nvidia-smi`) by its VRAM, anything else by RAM. The tiers and their budgets are in one table,
`TIERS` in `scripts/machine.ts`.

**Will it fit?** Every run first prints a plan: for each model, the memory it needs (the largest
reading in the ledger across suites, at its peak and its own context window inside a quality suite, else the catalogue size times a factor, else unknown) against
this machine's budget (Metal's working set on Apple silicon, VRAM on NVIDIA). A model is
*fits*, *tight* (over 80% of the budget), *offload* (over the budget but within usable system
memory: it runs with layers on the CPU, slower, and its speed is not comparable), *won't fit*
(beyond that) or *unknown*. Won't-fit models are skipped with an explanation (`--force` runs them
anyway); tight, offload and unknown ones warn. A model with results on this machine is never
won't-fit. It also warns when
the machine is busy (load, free memory, swap, battery, other heavy programs), since that skews
timings, and says what to close. `bun scripts/run.ts --plan` prints all this and runs nothing;
`setup.ts` uses the same check.

**Choosing what runs.** Each suite has categories (`text`, `vision`, `regions`, `search`,
`image-edit`, `audio`, `video`) and a cost (`light` or `heavy`), declared in `SUITE_META` in `scripts/plan.ts`.

```sh
bun scripts/run.ts --category vision,search      # by category
bun scripts/run.ts --cost light                  # light suites only
bun scripts/run.ts --models qwen3:4b --suites extract
```

**Machine profiles.** `machines/<name>.yaml` lists what a machine, or a class, runs (categories,
cost, suites, models, `skip_models`). It is picked with `--profile <name>`, or matched by the
machine's key or class (`match:`); `--profile none` ignores profiles. With no profile the default
is everything that fits. Command-line flags replace the profile's setting of the same name. To
add a machine, run `--plan` there, copy `machines/nvidia-24g.yaml`, set `match`, and commit it.

Each run also records the conditions it was taken under (`results/conditions/<run>.json`: load,
free memory, swap, power, thermal state, other heavy programs, before and after each eval); the
Runs and Speed pages flag runs taken under load. The frozen environment (`results/environments/`)
adds the OS, core counts, GPU, driver and CUDA version, and the versions of Bun, Node, Ollama,
onnxruntime, transformers.js, mflux and ffmpeg. Design notes: [docs/plans/machines.md](docs/plans/machines.md).

Expect large downloads: the Ollama models are a few GB each, and the edit model is 4.6 GB.

Results so far come from one Apple M4 Mac mini with 16 GiB (`apple-16g`).

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
| `edit` | edit | 20 Open Images and Commons photos and synthetic pages | Change the image as instructed (recolour, remove, add, weather, time of day, style, text); a judge answers yes/no questions about the edit, and outside the allowed region the image must stay close to the original (`providers/mflux-edit.ts`, `assertions/edit.ts`) |
| `similarity` | look (likeness) | 29 query photos ranked against a pool of 153 candidates | Rank the pool by likeness to the query: is a candidate a `copy` (resized, recompressed, cropped, flipped, brightened), an `edit` (our edit suite's output), the same `scene`, the same `class` of thing or `other`? pHash and dHash against DINOv2, DINOv3, SigLIP 2 and CLIP image encoders and the image side of EmbeddingGemma 2, a nomic text+vision pair and Jina CLIP v2; scored by average precision over copy, edit and scene, with recall@1 and @5 per level (`providers/image-embed.ts`, `assertions/similarity.ts`) |
| `search` | find | 231 text queries (plus 117 audio and video cases, below): 90 over photos (25 over the 78 originals, 65 harder ones over those plus 54 near-duplicate copies), 50 over 44 synthetic pages (read as images), 48 over all 7,793 USDA foods, 43 over 88 invented notes (28 of them hard distractors) | Rank a corpus for a typed query: which photo, page, food or note answers it? EmbeddingGemma 2 (text and vision, one space) against SigLIP 2, CLIP B/16, a nomic text+vision pair, Jina CLIP v2 (CC BY-NC, restricted), and the text embedders EmbeddingGemma 1 (Gemma terms, restricted), Qwen3-Embedding 0.6B and nomic-embed-text; scored by nDCG@10, passes at 0.7, with recall@1/5/10 and MRR kept (`providers/search.ts`, `assertions/search.ts`) |

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

The `search` suite (plans: `docs/plans/search.md`, `docs/plans/av-search.md`) measures retrieval with embedding models, in eight kinds of case (`metadata.kind`): the three below, and the audio and video ones described after them: `photos` (text to photos: object queries scored from Open Images annotations, descriptive ones by eye), `docs` (text to the synthetic pages, searched as images, no OCR) and `text` (USDA foods by a rule on the name, and invented CC0 notes). Since 2026-11-08 each kind has a harder set beside the original (near-duplicate photos, fine-grained page queries, paraphrase, negation and near-miss foods and notes), and the site splits each score into original and hard. Image to image is the `similarity` suite's job; the text+image embedders are providers there too (`providers/similarity-search.ts`). A provider embeds the corpus once per run (`corpora.yaml`) and ranks it per query, with each model's documented prefixes; `kinds` in a provider's config limits it to the inputs it can take, and `scripts/run.ts` runs one eval per kind. EmbeddingGemma 2 runs q8 (its card warns off float16), loading only the encoders a label needs (`embeddinggemma2` text and vision, `embeddinggemma2-audio` text and audio), and also records nDCG@10 at 256 dimensions. Five kinds are audio and video (written 2026-11-20, `scripts/av-search-sets.ts` says how each relevance list was judged, from file names, categories, summaries and poster frames, never by listening): `sounds` (38 text queries over 59 sound clips), `speech` (24 over 20 LibriVox readings), `videos` (29 over 39 silent videos), and the clip-to-clip `sound-to-sound` (16) and `video-to-video` (10), where a corpus clip is the query (`query_item`) and the pool holds derived copies of it (trimmed, recompressed, quieter; re-encoded, cut; `scripts/av-recipes.ts`, committed so their bytes never move) plus other clips of the same kind, scored by the same nDCG@10 with the similarity suite's copy, scene and class recall kept per case. The kind is `videos`, not `video`, because promptfoo's metadata filter matches substrings and `video-to-video` contains `video`. Case ids that start `sounds-hard-`, `speech-hard-` or `videos-hard-` are the near-miss set. Models: EmbeddingGemma 2 audio (`embeddinggemma2-audio`) and video as 1 fps frames (`embeddinggemma2`), CLAP HTSAT-unfused for sounds, Whisper base.en plus EmbeddingGemma 2 text for speech, SigLIP 2 frame-averaged for video, and an audio fingerprint of our own (no weights) for sound copies. ffmpeg decodes the clips (`providers/media.ts`). `--category audio` or `video` selects the suite; add `--kinds sounds,speech,sound-to-sound` (or `videos,video-to-video`) to run only those kinds. X-CLIP is not run yet. Two rivals are restricted (Jina CLIP v2: CC BY-NC 4.0; EmbeddingGemma 1: Gemma terms): marked in the catalogue and left out by the finder's permissive-licence filter.

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
region, the mean per-pixel difference from the original outside it must be at most `PRESERVED_MAX` (15 of 255, set from the drift of the edits that passed; the basis is in `assertions/edit.ts`). One case is a "change nothing" control (an empty region), which measures the editor's own drift. The score is the
mean of the answers and the preservation check; a case passes only when every question is yes and the image is
preserved. Time and peak memory of each edit are recorded as `edit_ms` and `peak_mb`.

All cases here are synthetic or from public-licence images.

## Private collections

A private collection is a set of cases and images that must not be published: personal photos,
screenshots of unreleased software, internal documents. It lives in `private/`, which git ignores,
and runs on the same models, scorers and machine checks as the public suites.

```sh
bun scripts/init-private.ts nudity-flag                  # a private copy of a public suite
bun scripts/init-private.ts screens --from tag-image     # a private-only suite, from a public suite's config
EVALS_SCOPE=private bun run eval --suites nudity-flag
```

`init-private.ts` writes `private/suites/<suite>/` with the config (file paths adjusted to the deeper
folder), an empty `cases/`, a template case and, with `--from`, a `suite.yaml` naming the suite's
categories and cost. A private-only suite without `suite.yaml` runs whatever categories a machine
profile selects. Images go in `private/images/`, referenced from a case as
`file://../../../images/<file>`.

With `EVALS_SCOPE=private`, snapshots, the ledger, raw output and the summary go to
`private/results/`, and the rules for cases are the same: once a run uses a case it never changes.
The site export refuses that scope, so private images and replies never reach the published site;
`bun run site:private` shows them locally (see Results site). Private images follow only the "Content" rules
of `docs/standards/corpus.md`, not its licence rules.

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
5-15 s, no sound track) are the clips for the audio and video kinds of the search suite (`docs/plans/av-search.md`), with derived copies (`copy-<recipe>-<parent>`, `scripts/av-recipes.ts`) of some of them for the clip-to-clip cases. The
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
`--repeat N` runs every case N times (the ledger keeps each repeat; the site shows medians with their spread).
The loop itself is `scripts/run-core.ts`, which the queue worker below shares.

### Timing

The Ollama text and vision suites (classify, extract, orchestrate, workout, ocr, tag-image) use
`providers/ollama-chat.ts` instead of promptfoo's built-in `ollama:chat:` provider, which records only wall-clock
latency. It sends the same request and returns the same output (so scores do not change), but streams the reply and
records, per call, as ledger `metrics`: `ttft_ms` (time to first content or tool-call token), `ttft_think_ms` and
`think_tokens` (thinking models), `load_ms`, `prompt_tokens`/`prompt_ms`/`prompt_tps`, `output_tokens`/`decode_ms`/`decode_tps`
and `total_ms`. Ollama does not count thinking tokens separately (`output_tokens` includes them), so `think_tokens` is the
number of streamed thinking chunks: close to the token count, not exact. The agent and decision providers
(`ollama-food-agent.ts`, `ollama-decide.ts`) record the same fields summed over their turns, plus `turn_ms`, and
`ollama-boxes.ts` records them per call; all share `providers/ollama-stream.ts`. The Speed & memory page and the
model finder show the medians and flag timings taken under load (a run's conditions), with a toggle to leave those out.

## Queued runs

To prepare tests ahead and run them when the machine is free, queue them. A job is one YAML file in `queue/`
(committed; one file per job so two branches never conflict and the worker rewrites only its own):

```yaml
id: 20261115-new-ollama-timing-provider-text-suites   # the file name
created: 2026-11-15T20:05:11Z
reason: "new Ollama timing provider: text suites"
models: [qwen3.5:4b, qwen3:4b]
suites: [classify, extract]
priority: 10             # higher runs first; ties go to the older job
needs:                   # what must hold before it runs; absent keys are not checked
  max_load_per_core: 0.3 # 1-minute load per logical core
  min_free_gib: 4        # memory available without swapping
  max_swap_gib: 2
  quiet_minutes: 10      # the above must hold continuously this long
  ac_power: true
  class: apple-16g       # only this class of machine runs it
  profile: apple-16g     # a machines/<name>.yaml to narrow with
repeat: 5                # optional: run every case 5 times
kinds: [docs]            # optional: only the cases of these kinds
status: pending          # pending | running | done | failed
run_ids: []              # the runs that did its evals
done: []                 # evals finished (model·suite): the resume point
notes: ""
```

```sh
bun scripts/queue.ts add --suites classify,extract --models all --reason "new prompt" --priority 5 \
    --needs load=0.3,free=4,quiet=10,ac=true      # short names: load free swap quiet ac class profile
bun scripts/queue.ts sync [--dry-run]            # queue every stale or missing (model, suite) on this machine, one job per suite
bun scripts/queue.ts list                        # open jobs: evals left, time (from past latency medians), does this machine fit
bun scripts/queue.ts drop <id>
bun scripts/queue.ts work [--once] [--max-hours 8] [--watch]
```

`work` takes the open job with the highest priority (a `running` one first: it resumes), waits until its `needs` hold
(sampling as `scripts/conditions.ts` does), then runs its evals through the same code as `bun run eval`. Between two
evals it checks again; if the machine got busy (the load average is not held against it there: it is mostly the eval's
own work, but another heavy program is) the job pauses, stays `running`, and carries on once the machine has been quiet
for `quiet_minutes`. Each finished eval is written into the job's `done` list, so killing the worker loses at most the eval
in flight; a restart resumes from the rest. A job whose evals error ends `failed` with the errors in `notes`; set
`status: pending` to retry what is left. `--max-hours` starts no new eval after that long, `--watch` keeps polling for new
jobs when none is waiting (for a service), and a lock (`queue/.worker.lock`) keeps two workers from running at once. Edit
a job's `priority`, `needs` or `status` any time: the worker re-reads the file before each eval, and `drop` ends a running job
at its next eval.

`machines/launchd/dev.small-model-evals.queue.plist` is an example launchd agent that keeps a worker running across
sessions; it is not installed (see the comments in it). The site's Queue page lists the open jobs as of the last export.

## Results

| Path | What | Committed |
| --- | --- | --- |
| `results/ledger/<suite>.jsonl` | One line per scored case, appended by every run | Yes |
| `results/suites/<suite>/<fp>.json` | Frozen suite snapshots the records link to | Yes |
| `results/summary.md` | Latest result per machine, model and suite, built from the ledger | Yes |
| `results/conditions/<run>.json` | How busy the machine was around each eval of a run | Yes |
| `results/notes/<run>.md` | Observations about a run that the numbers do not carry | Yes |
| `results/runs/<run>/` | promptfoo's raw output | No |

A ledger record names what produced it: the machine (hardware model, memory and class), the Ollama and
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
  `file://cases/*.yaml`, and an entry in `SUITE_META` (`scripts/plan.ts`) giving its categories and
  cost; `bun scripts/check.ts` fails without it.
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
(the private collection), listed as `private-<suite>`. Its data, images
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
