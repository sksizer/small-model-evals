// Name matching shared by scorers that compare a model's free-text label with
// an expected one (assertions/workout.ts, assertions/regions.ts). A synonym matches when its words appear in
// order in the model's label, after lower-casing, splitting on anything but
// letters and digits, and stemming each word (plural s, -ing with a doubled
// consonant undone, a final e): "push-ups" is "push up", "rowing" is "row",
// "biking" is "bike", "faces" is "face".
import type { Concept } from './tags.ts'

function stem(w: string): string {
  let x = w
  if (x.length > 5 && x.endsWith('ing')) {
    x = x.slice(0, -3)
    if (/([bdgmnpt])\1$/.test(x)) x = x.slice(0, -1)
  } else if (x.length > 2 && x.endsWith('s') && !x.endsWith('ss')) x = x.slice(0, -1)
  if (x.length > 3 && x.endsWith('e')) x = x.slice(0, -1)
  return x
}

const nameWords = (s: string) =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(stem)

/** Whether a model's label matches any synonym of the expected name. */
export function nameMatches(want: Concept, got: string): boolean {
  const hay = nameWords(got)
  return (Array.isArray(want) ? want : [want]).some((syn) => {
    const needle = nameWords(syn)
    for (let i = 0; needle.length > 0 && i + needle.length <= hay.length; i++) {
      if (needle.every((w, j) => hay[i + j] === w)) return true
    }
    return false
  })
}
