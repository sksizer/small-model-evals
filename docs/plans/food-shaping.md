# Plan: shaped food lookup

Status: built, full run queued (2026-11-21). Task: T-HGSL "F0: measure shaped food lookup against the tool loop"
(`solutions/personal/docs/planning/tasks/T-HGSL-personal-intake-measure-shaped-food-lookup.md` in the dev repo,
part of T-X761, personal agent function contexts). The owner chose `shape-hybrid` ("code then model if that
fails", 2026-11-21); this plan measures how far that rule holds and says plainly if another variant beats it.

## Goal

Know, per local model, how accurate and how fast four ways of turning a food note into database foods and grams
are, and whether the OpenAI-compatible endpoint the dashboard uses supports what the design needs. The meal
function in the dashboard is built on the variant the recommendation note names.

## Today

The `food-lookup` suite had 12 cases and one way of working: the model calls `search_foods` in a loop of up to 8
turns (`providers/ollama-food-agent.ts`), then one last call constrained to the answer schema. Results on the M4
with 16 GB: gemma4:e4b 10/12 in 24.8 s, qwen3.5:4b 8/12 in 23.5 s, qwen3.5:9b 8/12 in 30.2 s.

## What this adds

| Part | Where |
| --- | --- |
| 28 new cases (40 in all), the 12 originals untouched | `suites/food-lookup/cases/` |
| `loop` variant (today's, unchanged) | `suites/food-lookup/` |
| `shape-top`, `shape-choose`, `shape-hybrid` at lead ratios 1.05, 1.15, 1.5 | `suites/food-shape-*/`, `providers/ollama-food-shape.ts` |
| Grams conversion and the margin rule, as plain functions with `bun test` | `providers/food-shape.ts`, `providers/food-shape.test.ts` |
| The search with scores, for the margin | `providers/food-search.ts` (`searchScored`; `searchFoods` is unchanged in behaviour) |
| Endpoint check | `scripts/endpoint-check.ts`, result in `results/notes/` |
| Recommendation note (needs the full run) | `results/notes/2026-11-21-food-shaping.md` |

### How variants appear

This repo identifies a result by `(machine, model label, suite)`, and a model label is a model, so a variant cannot
be a second provider with the same label. Each variant is therefore its own suite, with the same three model
labels in it, which makes the ledger, the summary and the site tell them apart with no change to the runner:

| Suite | Variant |
| --- | --- |
| `food-lookup` | `loop` |
| `food-shape-top` | `shape-top` |
| `food-shape-choose` | `shape-choose` |
| `food-shape-hybrid-r105`, `-r115`, `-r150` | `shape-hybrid` at a lead ratio of 1.05, 1.15, 1.5 |

The shaped suites' `cases/` is a link to `food-lookup/cases/`, so every variant is scored on the same case files
with the same scorer (`assertions/food.ts`, unchanged) and the same database hash check. A suite's `variant` and `ratio` are provider config values (`providers/ollama-food-shape.ts`). The alternative, adding a model label per
variant and model (15 more entries in `scripts/models.ts` and `scripts/catalog.ts`), would have listed variants
as models on the site.

### The margin

The margin is a relative lead: the top match's score divided by the second's, and code takes the top match when
the ratio is at least the configured `ratio` (1.5 means top >= 1.5 x second). It is a ratio, not a score
difference, because the dashboard's meal handler will search with its own scorer on another scale, and a ratio
carries over where an absolute gap does not. A second score at or below zero counts as a lead (the ranking here
subtracts a tenth per extra name word, so scores can fall to zero). Ratio 1 is `shape-top`; a ratio no match can
reach is `shape-choose`.

Scorer the margin is measured with: `searchScored` in `providers/food-search.ts` (USDA SR Legacy, 7,793 foods;
2 points per query word in the name's first segment, 1 per word elsewhere, plus 1 when the name starts with a
query word, minus 0.1 per name word the query lacks; ties to the lower id). Every shaped result keeps, per item,
the top and second score (`decided[].top`, `decided[].second`) and who picked, so a ratio can be re-derived for
another scorer, or replayed on these results, without rerunning a model (the model's choices on the items that
went to it are in the reply too, so accuracy at a higher ratio can be recomputed; at a lower ratio only for items
code already decided).

The values 1.05, 1.15 and 1.5 come from the smoke run: gaps between the first two matches for plain foods are 0
to 0.2 points on scores of 2 to 6 (chicken breast 5.8 against 5.6, white rice 4.8 against 4.7, red wine 1.7
against 1.6, egg 2.8 against 2.8), so ratios near 1.05 to 1.1; branded and specific queries lead by 1 or more
points. A first sweep with absolute gaps of 0.2, 0.5 and 1.0 never let code decide on gemma4:e4b, which is why the
sweep is low. If the best ratio sits at an end of the sweep, extend it.

### What is recorded

Every shaped result carries, as ledger metrics: `searches`, `model_calls`, `items`, `code_decided`,
`model_decided`, and the timings of all calls summed (`turns` is the same as `model_calls`; `turn_ms` and
`total_ms` the wall clock of the model calls). The reply also keeps `shaped` (the first call's items) and
`decided` (per item: who picked, the top and second search scores, how the grams were reached) for reading a failure.

## Prior art checked

| Source | Verdict |
| --- | --- |
| `providers/food-search.ts`, `ollama-stream.ts`, `ollama-food-agent.ts`, `assertions/food.ts`, `build-foods.ts` | **Reused or extended.** Search, streaming with timings, the answer shape, the scorer and the db hash check are the loop's. `food-search.ts` gains `searchScored` |
| `scripts/run-core.ts`, `plan.ts`, `queue.ts` | **Reused unchanged** (suite registry gets five entries) |
| osdlc `packages/ts` (`result`, `command-seam`, `agent-call`, others) | **Not used.** `command-seam` is already the runner's; `agent-call` drives coding-agent CLIs, not an Ollama HTTP call; nothing there converts food portions |
| dev `packages/ts`, `tools` | **Nothing relevant** (no food, portion or structured-output helper) |
| [Ollama structured outputs](https://docs.ollama.com/capabilities/structured-outputs) | The native `format` is what the providers use; the OpenAI-compatible `response_format` is checked by `scripts/endpoint-check.ts` |
| `docs/plans/extraction.md` | Dedicated extractors (NuExtract, LFM2-Extract) are out of scope; add them to the shaping step only if the general models miss |

## Cases

28 new files, each with a new id, in groups: branded foods (4), foods the database lacks (3: the answer is a null
id), household units (4), counts with no unit (4), drinks (4), long multi-item notes (3), food planned or wanted
and not eaten (3), typos (3). Each expected food's name words and kcal per 100 g, and each gram value, were checked
against `suites/food-lookup/foods.jsonl`; null foods were checked absent. The 12 originals are byte-identical.

## Acceptance (T-HGSL)

- AC-1 cases: done.
- AC-2 results for the four variants, three models, every case: queued as one job (`queue/`); not yet run.
- AC-3 endpoint check: `results/notes/2026-11-21-endpoint-check.md`.
- AC-4 recommendation note: stub until the run finishes.
- AC-5 this plan, indexed in `docs/plans/README.md`.

## Next

Run the queued job (`bun scripts/queue.ts work`), regenerate `results/summary.md`, and replace the stub note with
the recommended model and margin, the numbers behind them, the expected seconds for a four-item note and how
often the model call was needed.
