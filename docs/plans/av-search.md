# Plan: audio and video search

Status: proposed (2026-11-06). Waiting on the owner's answers to the questions at the end.

## Goal

The `search` suite tests text, photos and document pages. EmbeddingGemma 2 also puts **audio** and
**video** in the same 768-number space, and those parts are untested. This plan adds both to the corpus
and to the search suite, and compares EmbeddingGemma 2 with the small open models built for each job.
Typical uses:
- finding a sound in a recordings folder ("a dog barking", "rain on a roof");
- finding the moment in a voice memo or a talk where something is said;
- searching home videos by what is in them ("kids on a beach", "a birthday cake");
- finding duplicate or near-duplicate clips.

## What EmbeddingGemma 2 takes (from its model card)

| Input | Format | Limit | Encoder |
| --- | --- | --- | --- |
| Audio | Mono, 16 kHz | About 327 s (25 tokens per second, 8,192-token window) | 300M; ONNX `audio_encoder*.onnx` in `onnx-community/embeddinggemma-2-ONNX` |
| Video | Sampled frames, 1 per second by default | About 58 frames at the default budget | The 170M vision encoder, the one `search` already runs |

Audio and video take no prefix. The card doesn't say whether a video's sound track is used. This plan
treats a video as its frames only, and tests the sound track separately as audio.

## Kinds of case

Each kind is a `metadata.kind` in the existing `search` suite, so the runner, scoring, gallery and Model
finder all carry over.

| Kind | Query | Searched over | Example |
| --- | --- | --- | --- |
| `sounds` | Text | Sound clips | "a dog barking", "a church bell", "traffic in rain" |
| `speech` | Text | Spoken recordings | "the part about the lighthouse", "the recipe for bread" |
| `sound-to-sound` | A clip | Sound clips | Another recording of the same kind of sound, or the same clip trimmed or recompressed |
| `video` | Text | Short videos | "a train arriving", "waves on a beach", "a rocket launch" |
| `video-to-video` | A clip | Short videos | The same clip re-encoded or cut, another clip of the same scene |

Scoring stays nDCG@10 (pass at 0.7), plus recall@1/5/10 and MRR, as in `search`. Clip-to-clip cases use the
similarity suite's levels (`copy`, `scene`, `class`, `other`).

## Corpus

Every clip follows `docs/standards/corpus.md`: CC0, public domain or CC BY, from a source whose licence can
be checked at the source. The standard gets an "Audio and video" section with the same rules.

| Source | Gives | Licence | In the standard today? |
| --- | --- | --- | --- |
| Wikimedia Commons | Sound effects, animal calls, instruments, ambience; short videos (NASA, government, own work) | CC0, PD, CC BY | Yes |
| LibriVox | Spoken readings of public-domain books | Public domain (recordings released to PD) | No: needs adding (Q2) |
| Freesound, CC0 filter only | Everyday sounds, cleaner and better labelled than Commons | CC0 | No: needs adding (Q2) |
| Made here | Copies (trimmed, recompressed, volume-shifted), tones and noise from code; maybe owner recordings (Q3) | CC0 | Yes ("made here") |

Not allowed, as for images: AudioSet and anything else from YouTube, ESC-50 (CC BY-NC), xeno-canto (mostly
NC), and scraped sets.

**Size:** the repo is public and the corpus is committed. Clips are stored small: audio as 16 kHz mono
Opus or FLAC, 5–30 s each; speech up to 2 minutes; video at 360p, 5–15 s, with no sound track (kept as a
separate audio clip). The target is about 60 sound clips, 20 speech clips and 40 videos. That's
roughly 25–40 MB in total (Q5).

**Sensitive content:** none. No children, no identifiable private people speaking, nothing intimate. Speech
comes only from public-domain readings or the owner's own recordings.

## Models

| Model | Does | Licence | Runs | Note |
| --- | --- | --- | --- | --- |
| EmbeddingGemma 2 | Text, audio, video (frames) | Apache-2.0 | ONNX, in-process | The model under test; 8-bit as in `search` |
| CLAP HTSAT-unfused (`laion/clap-htsat-unfused`, Xenova's ONNX) | Text ↔ sound | Apache-2.0 | ONNX, transformers.js | The standard open audio-text model (2023); trained on mixed-licence clips |
| Whisper base or small + a text embedder | Speech → transcript → text search | MIT (Whisper) | ONNX, transformers.js | The obvious pipeline for `speech`; should beat any audio embedder on spoken words |
| SigLIP 2 base, frames averaged | Text ↔ video, video ↔ video | Apache-2.0 | Already pinned | A baseline: does an image model with 1 frame per second do as well? |
| X-CLIP base/32 (`microsoft/xclip-base-patch32`) | Text ↔ video | MIT | Needs an ONNX export (Python, once) | Built for video; dropped if the export fails (Q6) |
| Chromaprint / audio hash | Sound ↔ sound copies | LGPL tool, our own small implementation otherwise | Local | The no-ML baseline, like pHash for images |

Restricted rivals (ImageBind, CC BY-NC) are included only if an ONNX build exists. ImageBind's is about
1.2B parameters, so it may not fit alongside anything else.

## Tooling

**ffmpeg isn't installed** on this machine. It's needed to:
- convert source clips to the stored formats;
- sample video frames (1 per second);
- decode clips at run time.

The plan adds it to `scripts/setup.ts`'s checklist (`brew install ffmpeg`) and runs it through
`@osdlc/command-seam`, as mflux is run (Q4).

## Site

- **Audio cases:** an inline `<audio>` player for each clip, and each model's top 5 as small players coloured
  green or red.
- **Video cases:** a poster frame plus a player.
- **Speech results:** the matching transcript line, where the pipeline gives one.
- **Model finder:** new tasks under Search: "Sound search by text", "Speech search", "Video search by text".

## Order of work

1. Owner answers the questions below.
2. The standard's "Audio and video" section, then the fetchers (Commons, plus LibriVox and Freesound if
   approved) with licence checks, and `ffmpeg` conversion into the committed formats.
3. A contact sheet of every clip (titles, licences, waveform or poster frame) for the owner to approve before
   cases are written.
4. Cases and relevance, judged by listening and watching. Clip-to-clip copies made by `scripts/recipes.ts`.
5. Providers: EmbeddingGemma 2's audio and frame paths, CLAP, Whisper plus text embedder, frame-averaged
   SigLIP, and X-CLIP if exportable.
6. Runs, site players, finder tasks, notes.

## Questions for the owner

- **Q1. Which kinds?** All five above, or a subset? `speech` is the most useful for voice memos.
  `sound-to-sound` and `video-to-video` are cheap once the corpus exists.
- **Q2. New sources.** May the standard add LibriVox (public-domain speech) and Freesound (CC0 filter only)? Without
  them, speech and everyday sounds come only from Commons, which has fewer and less consistent clips.
- **Q3. Your own recordings.** Would you record about 10 spoken voice-memo-style clips (invented content,
  released CC0) for `speech`? Or keep it to public-domain readings? A text-to-speech voice is the other option,
  but most voices' licences don't clearly allow republishing their output.
- **Q4. ffmpeg.** OK to require it (`brew install ffmpeg`), as mflux is required for the edit suite?
- **Q5. Size.** Is about 25–40 MB of committed audio and video acceptable, or should clips be fetched on setup and
  kept out of git, with only their hashes committed?
- **Q6. X-CLIP.** Worth a one-off Python export to ONNX (a pinned `optimum` run, like the mflux install), or drop
  it and let frame-averaged SigLIP 2 be the video rival?
