# Standard: the image corpus

Status: in force from 2026-11-04. It applies to every image under `corpus/`, the public corpus.
Private images (`private/`, gitignored) follow only the "Content" rules, and are never published.

## Licences: unencumbered only

Every corpus image must be free to copy, change and republish, for any purpose, with no
permission asked. The only allowed licences:

| Licence | Obligation | Typical source |
| --- | --- | --- |
| CC0 | None | Wikimedia Commons; our own synthetic pages and derived copies |
| Public domain (including PD-old, PD-US-gov, PD-self) | None | Wikimedia Commons |
| CC BY (2.0, 3.0, 4.0) | Credit the author, which `corpus/ATTRIBUTIONS.md` does | Open Images V7 (CC BY 2.0), Wikimedia Commons |

Not allowed, whatever the source:
- non-commercial (NC), no-derivatives (ND) or share-alike (SA, including GFDL);
- "all rights reserved", fair use, or an unknown or unstated licence;
- anything whose licence can't be checked from a primary source: the Commons file page, or the
  Open Images image list.

`scripts/fetch-corpus.ts` enforces this. It reads each Commons licence from the file page and
rejects anything outside `ALLOWED`, and it checks every Open Images image is listed as CC BY 2.0.
`scripts/check.ts` re-checks the manifest. A derived image (a resized or cropped copy) keeps its
parent's licence and credit. Our own synthetic pages are CC0.

## Sources

Images come from **Wikimedia Commons**, **Open Images V7**, or are made here (synthetic HTML pages
rendered by headless Chrome, and deterministic copies of corpus images). No other source without
updating this standard. Never a scraped dataset: NudeNet's training set, for example, was found to
contain abuse material.

## Content

- **Nudity:** adults only, CC0 or public domain, no vintage or ethnographic nudes. Marked
  `sensitive: true`, so the site covers them until a viewer chooses to see them.
- **Children:** only ordinary public scenes (a park, a sports day, a street), taken as they are
  from Open Images or Commons. Nothing else sensitive in the same image: no nudity, no swimwear
  or underwear, no documents. Never in any suite about nudity or intimacy. Marked
  `sensitive: true`.
- **Personal data:** no real person's documents, numbers, addresses, messages or health
  information. ID cards, bank cards, statements, screenshots, prescriptions and similar are
  synthetic pages with invented details, made here. They are marked as specimens: "SPECIMEN" on
  ID and bank cards, and card numbers that fail the Luhn check, so none can be a real card.
- **People in ordinary photos:** fine, as published on Commons or Open Images. Faces aren't
  blurred, since several suites test finding them.

## Text corpus

Status: in force from 2026-11-05. It applies to every text collection a suite searches or reads (the
search suite's notes and foods, `suites/search/corpora.yaml`), the way the rules above apply to images.

- **Same licence rules.** Only CC0, public domain, or CC BY (credited). Never non-commercial,
  no-derivatives, or share-alike: Wikipedia text (CC BY-SA) is out, whatever the topic.
- **Our own writing is CC0.** The 60 notes of `suites/search/notes.yaml` are written for this repo and released
  under CC0. They are invented: every person, place, number and appointment is made up, and none is
  real personal data or taken from a real message, note or document (the "Personal data" rule above).
- **Public-domain data is fine as is.** The USDA SR Legacy food database (`suites/food-lookup/foods.jsonl`) is
  a US government work, public domain. Name its source wherever a subset is built from it.
- **Relevance judgements are recorded.** A query's relevant items are judged by reading (notes), by a rule
  written in the picking script (foods), or from annotations (Open Images for photos); the case says
  which, so a later person can check it.
- **No scraped corpora.** The same reason as for images: a dataset's licence and contents can't be
  checked from a primary source.

## Audio and video

Status: in force from 2026-11-06. It applies to every sound, speech and video clip under `corpus/audio/` and
`corpus/video/`, the way the rules above apply to images. The plan is `docs/plans/av-search.md`.

- **Same licence rules.** Only CC0, public domain, or CC BY (credited). Never non-commercial, no-derivatives or
  share-alike (including GFDL), and never an unknown or unstated licence.
- **Sources.**
  - **Wikimedia Commons**: sounds and videos. The licence is read from the file page, as for images.
  - **LibriVox**: spoken readings of public-domain books. LibriVox releases its recordings to the public domain,
    but each one is checked: the archive.org item must be in the `librivoxaudio` collection and its metadata
    must state a public-domain or CC0 `licenseurl`. An item that states nothing is refused, whatever LibriVox
    says in general.
  - **Freesound, CC0 filter only.** Never a CC BY, CC BY-NC or "sampling" file from it. Freesound's API needs
    a key, so `scripts/fetch-av.ts` does not fetch from it; Freesound recordings that Commons hosts under CC0
    come in as Commons files.
  - **Made here**: derived copies of corpus clips (trimmed, recompressed, volume-shifted), and tones or noise
    from code. These keep their parent's licence and credit; the made-from-code ones are CC0.
- **Excluded.** AudioSet and anything else from YouTube, ESC-50 (CC BY-NC), xeno-canto (mostly NC), and any
  scraped set, for the reason given under "Sources" above.
- **Content.** No children (voices or pictures), nothing intimate, and no identifiable private person speaking
  or shown as the focus. Speech comes only from public-domain readings (LibriVox), never from conversations,
  calls or interviews. Videos are scenes, machines and animals; a person may pass through a public scene.
- **Stored audio.** 16 kHz mono Opus in an Ogg file (`.ogg`), about 24 kbps for sounds and 16 kbps for speech.
  Sounds run 5 to 30 s, speech 60 to 120 s. Opus is chosen over FLAC because the clips stay small (about 3 KB
  per second against about 15 KB for FLAC), which keeps the committed corpus within the size the plan
  allows; 16 kHz mono is the input EmbeddingGemma 2's audio encoder takes. Ogg Opus plays in current Chrome,
  Firefox and Safari, and ffmpeg reads it.
- **Stored video.** 360p H.264 in MP4 (`.mp4`), 15 frames per second, 5 to 15 s, with **no sound track**. MP4
  with H.264 is the one format every browser and ffmpeg handle without a codec build. Any sound the video had
  is not kept; the sound track is a separate audio clip only if it is licensed and picked as one.
- **Conversion.** Clips are converted from the source with ffmpeg by `scripts/fetch-av.ts`, trimmed to the
  segment the entry names (`start`, `duration`), with container metadata dropped. Each stored clip's sha256
  goes in `corpus/av-manifest.json`; like images, clips are immutable, and a changed clip gets a new id.
- **Credits.** `corpus/ATTRIBUTIONS.md` lists every clip, generated from the manifest. Speech clips also
  name the book's author and "LibriVox volunteers" as the readers.
- **Transcripts.** A speech clip carries a one-line `summary` and, where the book's text could be matched, an
  approximate `transcript` (the text of the chapter's opening). Both are display and judging aids, not part of
  the clip, and may be corrected without a new id.

## Changing this standard

Changing a rule is the owner's decision. Record the change and its date here.

- 2026-11-06: added the "Audio and video" section: LibriVox (public-domain readings) and Freesound (CC0 only) as
  sources beside Commons, the exclusions, the content rules for speech, and the stored formats (Opus in Ogg,
  H.264 in MP4 without sound).
