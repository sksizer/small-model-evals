# Food shaping: recommendation (T-HGSL, AC-4)

**STUB. The full run is queued and has not happened.** Nothing below is a result.

Queued job: `queue/20261122-food-shaping-*.yaml` (gemma4:e4b, qwen3.5:4b, qwen3.5:9b; suites `food-lookup` (loop),
`food-shape-top`, `food-shape-choose`, `food-shape-hybrid-r105`, `-r115`, `-r150`; 40 cases each). Run it with
`bun scripts/queue.ts work`, then `bun scripts/summarize.ts`.

To fill in once it has run:

- The recommended model and the lead ratio for `shape-hybrid`, with accuracy (cases passed of 40), median seconds,
  searches and model calls per case for every variant, per model.
- Expected seconds for a four-item note, and how often the choose call was needed (`metrics.model_decided` over
  `metrics.items`).
- Plainly, whether `shape-hybrid` loses to `shape-top`, `shape-choose` or the loop on accuracy or on time.
- The margin is a ratio of the top score to the second (not a difference) so it transfers to another search. State
  the scorer it was measured with: `searchScored` in `providers/food-search.ts` (see `docs/plans/food-shaping.md`).
  Each item's top and second score is in the result (`decided[].top`, `decided[].second`), so the ratio can be
  re-derived for the dashboard's own search.
