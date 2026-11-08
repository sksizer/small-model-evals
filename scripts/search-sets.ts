// Which search cases belong to the hard set added on 2026-11-08 (docs/plans/search.md), for the site's split of
// each kind's score into "original" and "hard". Cases carry no such mark in their files: they are immutable and
// the set was added after the first 89 were frozen, so the set is named here by id. scripts/pick-search.ts checks
// that this list and its hard note queries agree.

/** Case id prefixes of the hard set: photos over photos-dup, fine-grained page queries, and the foods over all 7793. */
export const HARD_PREFIXES = ['photos-dup-', 'docs-fine-', 'text-food-'] as const

/** Slugs of the hard note queries (their case ids are `text-note-<slug>`). */
export const HARD_NOTE_SLUGS = [
  'cold-lentil-dish', 'no-cook-breakfast', 'flight-madrid', 'hire-car', 'car-insurance', 'dumbbell-day', 'hose-connector',
  'marathon-signup', 'optician', 'pet-travel', 'mum-dinner', 'focus-book', 'mesh-wifi', 'stolen-bike', 'pager-app', 'cloud-exam',
  'evening-wind-down', 'interview-schedule',
] as const

/** Whether a search case id is in the hard set. */
export const isHardSearchCase = (id: string): boolean =>
  HARD_PREFIXES.some((p) => id.startsWith(p)) || HARD_NOTE_SLUGS.some((s) => id === `text-note-${s}`)
