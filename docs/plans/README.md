# Plans

| Plan | State | Next |
| --- | --- | --- |
| [machines](machines.md) | Built | — |
| [similarity](similarity.md) | Built | — |
| [sensitive](sensitive.md) | Built | — |
| [search](search.md) | Built | — |
| [av-search](av-search.md) | Runs done (2026-11-21) | EmbeddingGemma 2 `sounds` query check, unsure cases, review, PR |
| [extraction](extraction.md) | Proposed | Owner answers Q1–Q5 |
| [image-gen](image-gen.md) | Proposed | Owner answers Q1–Q4 |
| [transcribe](transcribe.md) | Approved | Corpus (stage 1) |

## Queued runs

`bun scripts/queue.ts list` shows jobs waiting for compute. The timing reruns for the Ollama suites
(`queue/20261115-*.yaml`, about 3.6 h on apple-16g) haven't run yet; any machine can run them with
`bun scripts/queue.ts work` and commit the results in a PR.
