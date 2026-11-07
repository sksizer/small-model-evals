// The corpus licence allow-list from docs/standards/corpus.md, shared by
// scripts/fetch-corpus.ts (which enforces it on download) and scripts/check.ts
// (which re-checks the manifest). CC0, public domain and CC BY only: nothing
// share-alike, non-commercial, no-derivatives or unstated.

/** The licence names allowed for a Wikimedia Commons file, as its file page states them. */
export const ALLOWED = /^(CC0( 1\.0)?|Public domain|PD\b.*|CC BY \d(\.\d)?)$/i

/** The licences a LibriVox recording may have: the archive.org item's licence URL says public domain or CC0. */
export const LIBRIVOX_LICENCE = /^(Public domain|CC0)$/

/** The only licence an Open Images V7 photo may have (its image list names it; fetch-corpus.ts checks the URL). */
export const OI_LICENCE_NAME = 'CC BY 2.0'

/** The fields of a manifest entry the licence check reads. */
export interface Licensed {
  id: string
  title: string
  licence: string
  derived_from?: string
}

/**
 * Why a manifest entry's licence breaks the corpus standard, or null when it
 * is fine. An Open Images photo must be exactly CC BY 2.0, a synthetic page
 * CC0, a LibriVox recording public domain or CC0, a derived copy must match
 * its parent, and a Commons file (image, sound or video) must be on ALLOWED.
 */
export function licenceProblem(m: Licensed, byId: Map<string, Licensed>): string | null {
  if (m.derived_from) {
    const parent = byId.get(m.derived_from)
    if (!parent) return `${m.id}: parent ${m.derived_from} is not in the manifest`
    if (m.licence !== parent.licence) return `${m.id}: licence "${m.licence}" differs from its parent ${parent.id} ("${parent.licence}")`
    return licenceProblem(parent, byId)
  }
  if (m.title.startsWith('Open Images ')) return m.licence === OI_LICENCE_NAME ? null : `${m.id}: Open Images photo has licence "${m.licence}", not ${OI_LICENCE_NAME}`
  if (m.title.startsWith('LibriVox ')) return LIBRIVOX_LICENCE.test(m.licence) ? null : `${m.id}: LibriVox recording has licence "${m.licence}", not public domain or CC0`
  if (m.title.startsWith('synthetic/')) return m.licence === 'CC0' ? null : `${m.id}: synthetic page has licence "${m.licence}", not CC0`
  return ALLOWED.test(m.licence) ? null : `${m.id}: licence "${m.licence}" is not on the allow-list`
}
