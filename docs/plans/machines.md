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
   image editor's `peak_mb`), taken as the maximum across the suites the model ran (in-suite Ollama memory
   is higher than the perf suite's; in perf only the 8K-context case counts). Readings from the same class
   of machine win over others.
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
includes any CPU-offloaded layers. qwen3.5:9b needs 13.8 GiB against apple-16g's 11.8 GiB budget, so it is
*offload*: it ran, with layers on the CPU.

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
