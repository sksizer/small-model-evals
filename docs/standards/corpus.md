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

## Changing this standard

Changing a rule is the owner's decision. Record the change and its date here.
