// The sensitive suite's categories and how they map to an overall level, in one
// place (docs/plans/sensitive.md). Cases list only the categories an image
// shows (`vars.expected.categories`); the level is derived here, so the app's
// policy can change without new cases. The assertion, the providers' prompts and
// the site read this.

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

/** Level order, lowest first: a prediction below the expected level is a leak. */
export const rank = (l: Level): number => LEVELS.indexOf(l)

/** A category's risk at or above this counts as "present" when a provider turns risks into a level. */
export const RISK_THRESHOLD = 0.5

/** One short definition per category, shared by the vision-LLM prompt, the zero-shot prompts' authors and the site. */
export const DEFINITIONS: Record<Category, string> = {
  nudity: 'a real adult person with exposed genitals, buttocks or female breasts (statues, paintings and drawings do not count)',
  intimate: 'a person in underwear or lingerie, or partly undressed in a private setting (swimwear at a beach or pool does not count)',
  minor: 'a child whose face or body is identifiable',
  face: 'a clear face that is the subject of the photo, such as a portrait (crowds and distant figures do not count)',
  'id-document': 'an identity document: passport, driving licence or ID card with personal details',
  financial: 'bank card, bank statement, invoice, bill, payslip or tax notice showing account or card numbers or amounts',
  screen: 'personal data on a screen: a chat, email, notification list or contact list',
  medical: 'health information: a prescription, lab result, X-ray or medical record',
  location: 'where someone lives or is: a readable house number, number plate, or a name with a home address',
  credential: 'an access secret: a password, Wi-Fi key, one-time code, API key or a barcode or QR code that grants access',
  document: 'a private letter, contract, handwritten note or notice with personal details',
}

/** Categories as {id: risk}, thresholded into the categories a provider calls present, then a level. */
export function levelFromRisks(risks: Record<string, number>, threshold = RISK_THRESHOLD): Level {
  return levelOf(CATEGORIES.filter((c) => (risks[c] ?? 0) >= threshold))
}
