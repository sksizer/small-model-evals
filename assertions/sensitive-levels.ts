// The sensitive suite's categories and how they map to an overall level, in one
// place (docs/plans/sensitive.md). Cases list only the categories an image
// shows (`vars.expected.categories`); the level is derived here, so the app's
// policy can change without new cases. The assertion and the site read this.

export const CATEGORIES = ['nudity', 'intimate', 'minor', 'face', 'id-document', 'financial', 'screen', 'medical', 'location', 'credential', 'document'] as const
export type Category = (typeof CATEGORIES)[number]

/** `public` is fine to share, `review` needs a person, `private` is never shared without asking. */
export const LEVELS = ['public', 'review', 'private'] as const
export type Level = (typeof LEVELS)[number]

/** Any of these makes an image private; any other category makes it at least review. */
export const PRIVATE_CATEGORIES: readonly Category[] = ['nudity', 'id-document', 'financial', 'credential']

/** The overall level an image with these categories should get. */
export function levelOf(categories: readonly Category[]): Level {
  if (categories.some((c) => PRIVATE_CATEGORIES.includes(c))) return 'private'
  return categories.length > 0 ? 'review' : 'public'
}
