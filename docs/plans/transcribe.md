# Plan: speech to text (transcription)

Status: approved (2026-11-23); the owner's answers are under "Decisions" at the end. Stage 1 built (66 clips, contact sheet `results/contact/av-corpus.html`, `bun scripts/build-av-contact.ts`) and waiting on the owner's listen-through; stage 2 built (scorer, provider, 8 pinned models, 66 cases, site) but never run. Next: owner approves the clips, queue the 8 models for a quiet period, then stage 3 (`brew install whisper-cpp`, Apple Swift CLI), the private suite (Q3), review, PR. This branch sits on `suite/av-search`; open its PR after that one merges.

## Goal

Find the smallest model that writes down what was said accurately enough to read, on a 16 GB Mac. Typical uses:
- voice memos and dictation becoming notes;
- a talk, lecture or podcast becoming searchable text;
- recordings in another language becoming text in that language.

`search` already runs Whisper base.en inside the `speech` kind, but only scores whether the right clip ranks
first. It never checks the words. This plan adds a `transcribe` suite that does.

## The suite

Laid out like `ocr`: one immutable case file per clip, naming the clip and its exact reference transcript.

```yaml
description: "LibriSpeech test-clean 1089-134686-0000"
metadata: { id: ls-1089-134686-0000, kind: read, language: en }
vars:
  audio: corpus/audio/asr-ls-1089-134686-0000.ogg
  reference: "he hoped there would be stew for dinner turnips and carrots and bruised potatoes ..."
```

**Scoring.** Word error rate (WER): (substitutions + deletions + insertions) / reference words, after both
texts are normalised the usual way (lowercase, punctuation dropped, numbers and spellings put in one form, as
Whisper's English normaliser and the Open ASR Leaderboard do). A case passes at WER ≤ 10% for clean read speech and ≤ 20% for harder kinds (set per kind).
The site shows WER, the reference and the hypothesis with the differences marked, and speed as the
real-time factor (seconds of audio per second of compute).

**Kinds**, as `metadata.kind`:

| Kind | What | Source |
| --- | --- | --- |
| `read` | Clean read speech, one speaker | LibriSpeech test-clean (CC BY 4.0) |
| `read-hard` | Accented, noisy or poorly recorded read speech | LibriSpeech test-other; Common Voice (CC0) |
| `long` | 1–2 minute readings: tests chunking, the first 30 s isn't everything | Consecutive LibriSpeech test-clean utterances of one chapter joined into one clip; the reference is their transcripts joined, so it is exact |
| `noisy` | Clean clips mixed with corpus sounds (rain, traffic, cafe) at set loudness | Made here, from `read` clips and corpus sounds |
| `conversation` | Meetings, several speakers, overlap (Q1) | AMI (CC BY 4.0, to verify); needs a standard change |

About 60 English clips, 5–30 s each except `long` (English only, Q2). Every source's licence is
checked at the source before anything is fetched.

**Contamination.** LibriSpeech, Common Voice and FLEURS are in many models' training data and every model
reports its LibriSpeech score. The `long` joins and the `noisy` mixes are the guard: a
model that does far better on LibriSpeech than on those is remembering, not listening.

## Models

| Model | Size | Licence | Runs as | Note |
| --- | --- | --- | --- | --- |
| Whisper tiny.en, base.en, small.en | 39M–244M | MIT | transformers.js (ONNX), as `search` | The baseline everyone knows |
| Whisper large-v3-turbo | 809M | MIT | transformers.js and whisper.cpp | The usual "good enough" ceiling |
| Distil-Whisper (distil-small.en, distil-large-v3.5) | 166M, 756M | MIT | transformers.js | Faster Whisper students |
| Moonshine (v1 tiny/base; v2 streaming small) | 27M–123M | MIT (to confirm) | transformers.js (v1); v2 ONNX to confirm | Built for small devices |
| Parakeet TDT 0.6B v3 | 0.6B | CC BY 4.0 (to confirm: NVIDIA lists two licences) | ONNX (community export) | Near the top of the Open ASR Leaderboard |
| Granite Speech 4.1 2B | 2B | Apache-2.0 (to confirm) | Only if transformers.js or whisper.cpp runs it | Reported top of the leaderboard under 3B |
| Apple SpeechTranscriber | OS | macOS | A small Swift CLI over the Speech framework (Q4) | Built into macOS 26, nothing to download |

Every model is pinned to a revision, as elsewhere. The 12-month rule applies; Whisper and Moonshine v1 are
baselines. Anything unconfirmed above is checked before it is pinned and dropped if it doesn't hold up.

## Tooling

- `providers/transcribe.ts`: one promptfoo provider, `family` per runtime: `transformers`, `whisper-cpp`
  (the `whisper-cli` binary from brew, ggml models pinned by sha256) and `apple` (a small Swift CLI over
  `SpeechTranscriber`, built by `scripts/setup.ts`, like `scripts/metal-working-set.swift`). It decodes through `providers/media.ts` (16 kHz mono) and returns the text plus timing.
- `assertions/wer.ts`: the normaliser and WER/CER, with tests. A small hand-written implementation; no new
  dependency unless an existing one covers the normaliser.
- `scripts/fetch-av.ts` grows the new sources; `scripts/av-recipes.ts` makes the `noisy` mixes.
- A plain `scripts/transcribe.ts <folder>` for transcribing your own files with any pinned model, writing a
  `.txt` beside each one. The same provider code, outside promptfoo.
- Site: a transcription table per kind and a diff view per case.

## Stages

1. Corpus: fetch, convert, contact sheet with players for the owner's check.
2. Scorer, provider (transformers.js models first), cases, smoke test, runs, site.
3. whisper.cpp and Apple SpeechTranscriber, one at a time.

## Questions for the owner

- **Q1. Conversation.** The corpus standard allows only public-domain readings for speech. Add meeting
  recordings (AMI, CC BY 4.0, consenting adult participants) as a `conversation` kind? Recommended: yes,
  with a standard change limited to corpora recorded with consent for research.
- **Q2. Languages.** English only, or English plus a handful? Recommended: English plus French, German,
  Spanish and Japanese, 10 clips each.
- **Q3. Your own recordings.** Test on your own voice memos through the private scope
  (`EVALS_SCOPE=private`, `bun scripts/init-private.ts transcribe-mine --from transcribe`)? This needs you to
  write the reference transcripts, or correct a model's draft.
- **Q4. Runtimes.** transformers.js covers most models in-process. The others each add a tool to install:
  whisper.cpp (brew), mlx-vlm (Python, for Gemma 4 audio and maybe Granite), and a Swift CLI for Apple's API.
  Recommended: all three, in stage 3, each dropped if it can't be pinned.

## Decisions (owner, 2026-11-23)

- **Q1:** yes. `conversation` from AMI, with the corpus standard changed to allow speech corpora recorded with
  the speakers' consent for research, under the usual licence rules.
- **Q2:** English only. The `languages` kind is dropped; `.en` model variants are fair game.
- **Q3:** yes. A private suite for the owner's own recordings, set up with `init-private.ts`.
- **Q4:** whisper.cpp and Apple SpeechTranscriber. No Python runtime, so Gemma 4 audio waits until Ollama or
  transformers.js takes audio for it.
