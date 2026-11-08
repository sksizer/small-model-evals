# Multi-machine support

Results come from more than one machine, and a 16 GB Mac and a 24 GB NVIDIA box must never be
averaged together or asked to run what they cannot hold. This is what was built, and why.

## What exists

| Piece | Where |
| --- | --- |
| Machine identity and class, tiers | `scripts/machine.ts` |
| Memory need and fit | `scripts/fit.ts` |
| Categories, profiles, the plan | `scripts/plan.ts`, `machines/*.yaml` |
| Conditions at run time | `scripts/conditions.ts`, `results/conditions/<run>.json` |
| Frozen environment facts | `scripts/env.ts`, `results/environments/` |
| Per-class views | `scripts/export-site.ts`, `site/` |

## Machine class

`machine()` works on macOS (Apple silicon and Intel), Linux and Windows, and fails soft to a CPU-only
machine. The `key` format of existing Macs (`Mac16,10-16g`) is unchanged, so old records still group
the same. Elsewhere it is `<product>-<gpu>-<ram>g`, naming no person or host.

The class is `<accelerator>-<tier>g`. A machine is in the largest tier it fully meets, measured in the
memory a model actually lives in:

| Accelerator | Tiered by | Tiers (GiB) | Budget (share of the tier) |
| --- | --- | --- | --- |
| `apple` | installed unified memory | 8, 16, 24, 32, 48, 64+ | 75% (67% at 8): Metal's default working set |
| `nvidia` | VRAM | 4, 6, 8, 12, 16, 24, 32, 48+ | 95%: driver and display overhead |
| `cpu` (Intel Mac, AMD, none) | RAM | 4, 8, 16, 32, 64+ | 60%: the OS and other programs need room |

The top tier is open-ended (`apple-64g+`). A real machine's own budget is measured where the OS says
(Metal's `recommendedMaxWorkingSetSize`, via `scripts/metal-working-set.swift`; the card's VRAM); the
nominal share above is for comparing classes. The tiers live in `TIERS`; nothing else repeats them.

Old records carry no class. `describe()` derives it at read time from `chip`, `hw_model` and `mem_gib`
(an `Apple` chip is Apple silicon); the ledger is never rewritten. New records store it.

## Will it fit

A model's need, in GiB, from the first source that has one:

1. **Measured**, from the ledger: Ollama's `loaded_bytes` plus any in-process memory (`rss_mb`, or the
   image editor's `peak_mb`), taken as the maximum across the suites the model ran. In the perf suite only
   the 8K-context case counts, a median of its repeats: a fresh load on text. In every other suite it is the
   **peak** over the suite's requests, taken at that suite's own context window, which the note names
   ("measured, sensitive loaded peak at 4K context"). Readings from the same class of machine win over others.
2. **Catalogue**: `disk_gb` times a factor for what a loaded model adds (Ollama 1.25, ONNX and mflux 1.5,
   no-weights models 1).
3. **Unknown.**

Against the accelerator's budget, with a second limit for spilling into system memory (`spill`):

| Status | Need | Meaning |
| --- | --- | --- |
| fits | up to 80% of budget | runs on the accelerator |
| tight | 80-100% of budget | little room for the OS, context or a second model; warns |
| offload | over budget, within `spill` | Ollama (or the unified-memory runtime) keeps the rest on the CPU: it runs, slower, and its speed and memory are **not comparable**; warns loudly |
| won't fit | over `spill` | skipped, loudly, unless `--force` |
| unknown | no number | runs; warns |

`spill` is, on Apple silicon and CPU-only machines, installed RAM minus a 3 GiB OS reserve (13 GiB at
16 GB), since layers offloaded to the CPU sit in the same memory; on NVIDIA it is VRAM plus 60% of system
RAM (`OS_RESERVE_GIB`, `SPILL_SHARE`, `TYPICAL_HOST_GIB` in `machine.ts`; a class on the site assumes a
32 GiB host). A model that has a result on this machine key is never won't-fit there: it demonstrably ran,
so at worst it is offload. `run.ts` and `setup.ts` print the plan and skip only won't-fit models.
When some of the selected suites have a reading for a model, only those count; otherwise its largest reading
anywhere.

The measured need is an upper bound of a kind: `rss_mb` is the whole process, and Ollama's loaded size
includes any CPU-offloaded layers. qwen3.5:9b needs 15.2 GiB against apple-16g's 11.8 GiB budget, so it is
*offload*: it ran, but see the next section for what that number is.

### Why in-suite Ollama memory is higher than the perf suite's (2026-11-08)

The finder used to show qwen3.5:9b at 7.9 GB (the perf suite, 8K context, a fresh load, text) while the fit
need said 13.8 GiB (the sensitive suite, median). Both are right; they measure different things:

| Reading | Where | Context | What it is |
| --- | --- | --- | --- |
| 7.3 GiB | perf, `ctx-8k` | 8192 | A fresh load answering text prompts: weights plus a cache for 8K |
| 7.2 GiB | sensitive, the first request | 4096 | The same fresh load, one image |
| 15.2 GiB | sensitive, request 70 on | 4096 | The plateau after about 70 image requests |

The context is not the cause: the sensitive suite's context is *smaller* (4096, the provider's default) than
perf's 8K, and perf's 32K case (7.3 GiB) is no higher than its 4K case, so on text the context barely moves
the reading. The cause is the number of image requests Ollama has served on one load. Ollama's reported size
(`/api/ps` `size`) climbs by about 0.12 GiB per request for qwen3.5:4b and about 0.15 GiB for 9b, from 3.8 to
11.8 GiB (4b) and from 7.2 to 15.2 GiB (9b), then stops: the same +8.0 GiB for both models, so it is not the
weights and not a KV cache (which would scale with the model). lfm3-vl:2b climbs 1.6 to 3.2 GiB and gemma4:e4b
not at all. Two independent runs of each model (2026-11-04) climb in step, to within 0.01 GiB at the same
request number, so it follows the request count, not the content of the images. Text requests (perf: nine
requests, up to 32K tokens) do not climb. The most likely cause is memory the vision path keeps per request in
the llama.cpp runner (its image embedding and graph buffers) until a plateau; the ledger cannot tell whether
the runner would give it back under pressure. What it does show:

- Speed does not degrade at the plateau (qwen3.5:9b: about 10 s per image early and late), so layers are not
  being pushed to the CPU; the extra is held memory, not a spill.
- A real app that keeps the model loaded and sends it hundreds of photos would see the plateau; one that loads,
  rates a few images and unloads sees about the fresh-load figure plus 0.15 GiB per image.

What changed so the numbers say what they measure:

- `suiteNeed` (`scripts/fit.ts`) takes the **peak** of an in-suite reading, not its median (the median of a
  ramp only says where the middle request fell), and names the context window in the note.
- The finder's Memory column shows the fresh load with its context ("7.9 loaded · 8K ctx, fresh"), and, when
  the in-suite peak is at least 5% higher, a second line "15.7 peak in sensitive · 4K ctx" (hover: request
  count). Its memory limit and sort use the larger of the two; the Fits column uses the peak.
- The context window of an in-suite reading comes from the suite's config, else the provider's default
  (`PROVIDER_DEFAULT_CTX` in `fit.ts`), not from the record: adding `num_ctx` to `providers/ollama-sensitive.ts`'s
  metadata would have made every sensitive result stale. The perf suite records `num_ctx` per reading, and
  records made from now on can too.
- qwen3.5:4b's need moved from 10.4 GiB (the median) to 11.8 GiB (the peak): *tight* on the class's nominal 12 GiB
  budget (the site), right at this machine's own 11.84 GiB (where `run.ts` can call it *offload* by a hair). By
  the speed evidence above, read a high need here as "its memory climbs to the budget with images", not "layers
  run on the CPU".

## Categories and profiles

Suites carry categories (`text`, `vision`, `regions`, `search`, `image-edit`; `audio` and `video`
reserved) and a cost (`light`, `heavy`) in `SUITE_META` (`scripts/plan.ts`). They are not in each
suite's `promptfooconfig.yaml` because a snapshot freezes that config: adding metadata there would change
every suite's fingerprint and make every recorded result stale. `scripts/check.ts` fails on a suite with
no entry.

A profile is `machines/<name>.yaml`: `match` (machine `keys` or `classes`), and optional `categories`,
`cost`, `suites`, `models`, `skip_models`. Selection narrows profile, then command line (a flag replaces
the profile's setting of the same name), then fit. With no profile: everything that fits.

## Conditions and environment

Frozen per environment (`results/environments/<hash>.json`): class, accelerator, GPU, budget, core counts,
OS, driver and CUDA, and the versions of Bun, Node, Ollama (and its settings), promptfoo, onnxruntime,
transformers.js, sharp, mflux and ffmpeg. The `power` string moved out: it changes during a run.

Per run, `results/conditions/<run>.json` holds, for each (model, suite) eval, a sample before and one
after: load average, available memory and memory pressure, swap, AC or battery, Low Power Mode, thermal
limit, and other programs using over 40% of a core. It is a file per run, not a field per record, because
a run has thousands of records and a few dozen evals, and the ledger is append-only. An eval is flagged
when a threshold (`LIMITS` in `conditions.ts`) is crossed; the load average counts only before the first
eval, since later it is mostly the eval's own work. The Runs and Speed pages show the flag.

## Site

Results are always per machine. A picker (shown when there is more than one machine) chooses whose
results the leaderboard, speed and model pages show; the finder has its own machine picker, and a
"Fits on" class picker (default: the machine's class) that sets the fit badge on each row. Nothing is hidden
by default; "Hide won't-fit" removes those rows. Model pages show a fit pill per class. All of it is computed in `export-site.ts`.

## Adding a machine

1. Clone, `bun install`, `bun scripts/run.ts --plan`. Check the class and the fit table.
2. If the machine should run a subset, copy `machines/nvidia-24g.yaml`, set `match` and the categories.
3. `bun scripts/setup.ts`, then `bun run eval`.
4. Commit `results/`. The site groups the new machine separately.

A new accelerator (AMD ROCm, say) is a new key in `TIERS`, a branch in `machine()`, and the class names
follow.

## Not done

- No remote or scheduled orchestration of many machines; each runs by hand.
- AMD GPUs are classed as CPU until someone adds ROCm detection.
- Multi-GPU boxes are classed by their largest card.
