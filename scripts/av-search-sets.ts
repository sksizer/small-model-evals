// What the audio and video search cases are made of (docs/plans/av-search.md): which clips get derived
// copies, the clip-to-clip scene links, the text queries with their relevant clips, and the corpora they
// run over. scripts/pick-av.ts turns this into cases and sources; scripts/pick-search.ts appends the
// corpora to suites/search/corpora.yaml.
//
// How relevance was judged (cases are never listened to or watched in full; Commons descriptions are not
// stored in the manifest):
// - sounds: the clip's Commons file name and its category. A clip is relevant when the file name says what
//   the query asks for ("Purring cat" for "a cat purring"). Near misses are left out on purpose (a howl is
//   not a bark, a pebble beach is not a tap). Queries marked "unsure" rest on a title that is thin.
// - speech: the clip's `summary` (book, chapter and topic). The clip opens with LibriVox's spoken
//   introduction, then the chapter; a query asks about the chapter's topic, which the first 100 s cover.
// - videos: the clip's Commons file name and category, checked against its poster frame
//   (results/contact/posters). Several poster frames are black or a title card (rocket-launch-1, -3), so
//   those clips rest on the file name alone.
// - sound-to-sound, video-to-video: the clip's category and, for video scenes, a shared source (the two
//   Malden Center arrivals, the two Kawaida waterfall views). Levels as in the similarity suite: `copy`
//   (a derived copy of the query), `scene` (another clip of the same place or event), `class` (a different
//   clip of the same kind of thing). Every clip counts by its original: a copy of a class clip is class.
import type { CorpusMedia } from './fetch-av.ts'
import type { AvRecipe } from './av-recipes.ts'

export interface Query {
  slug: string
  query: string
  relevant: string[]
  how: string
  /** Near-miss or otherwise hard; the case id carries `hard-` (scripts/search-sets.ts). */
  hard?: true
}

const FILE = 'by file name and category'
const UNSURE = 'by file name; unsure, the title is thin'

// ---- derived copies -----------------------------------------------------------------------------

/** Sound clips that get two copies each (parents of 10 s or more, so a trim stays over 5 s); every one's peer in its category is left uncopied. */
export const SOUND_COPY_PARENTS = [
  'snd-canine-1', 'snd-frog-1', 'snd-rain-2', 'snd-thunder-1', 'snd-wind-1', 'snd-sea-waves-1', 'snd-helicopter-1', 'snd-airplane-1',
  'snd-train-1', 'snd-bell-1', 'snd-clock-1', 'snd-typing-1', 'snd-cooking-1', 'snd-flute-1', 'snd-guitar-1', 'snd-piano-1',
]
/** Video clips that get a re-encode and a cut each (parents of 8 s or more). */
export const VIDEO_COPY_PARENTS = [
  'vid-tram-1', 'vid-horse-1', 'vid-traffic-1', 'vid-clouds-2', 'vid-snow-1', 'vid-airplane-1', 'vid-ship-2', 'vid-insect-1', 'vid-train-2', 'vid-waterfall-1',
]

const SOUND_RECIPE_PAIRS: AvRecipe[][] = [['trim', 'recode'], ['recode', 'quiet'], ['quiet', 'trim']]

export interface CopySource { id: string; kind: 'sound' | 'video'; category: string; derived: string; recipe: AvRecipe }

/** The derived copies, as av-sources.yaml entries. */
export function copySources(manifest: CorpusMedia[]): CopySource[] {
  const byId = new Map(manifest.map((m) => [m.id, m]))
  const parent = (id: string) => {
    const m = byId.get(id)
    if (!m) throw new Error(`copy parent ${id} is not in the manifest`)
    return m
  }
  return [
    ...SOUND_COPY_PARENTS.flatMap((p, i) =>
      SOUND_RECIPE_PAIRS[i % SOUND_RECIPE_PAIRS.length]!.map((recipe) => ({ id: `copy-${recipe}-${p}`, kind: 'sound' as const, category: parent(p).category, derived: p, recipe })),
    ),
    ...VIDEO_COPY_PARENTS.flatMap((p) => (['reencode', 'cut'] as const).map((recipe) => ({ id: `copy-${recipe}-${p}`, kind: 'video' as const, category: parent(p).category, derived: p, recipe }))),
  ]
}

// ---- corpora --------------------------------------------------------------------------------------

export interface MediaItem { id: string; file: string; title: string }

const item = (m: CorpusMedia): MediaItem => ({ id: m.id, file: `corpus/${m.file}`, title: m.kind === 'speech' ? (m.summary ?? m.title) : m.title.replace(/^File:/, '') })

/** The five av corpora: originals of each kind, and for sounds and videos also the derived copies. */
export function avCorpora(manifest: CorpusMedia[]): Record<string, MediaItem[]> {
  const originals = (kind: CorpusMedia['kind']) => manifest.filter((m) => m.kind === kind && !m.derived_from)
  const copies = (kind: CorpusMedia['kind']) => manifest.filter((m) => m.kind === kind && m.derived_from)
  return {
    sounds: originals('sound').map(item),
    'sounds-dup': [...originals('sound'), ...copies('sound')].map(item),
    speech: originals('speech').map(item),
    videos: originals('video').map(item),
    'videos-dup': [...originals('video'), ...copies('video')].map(item),
  }
}

/** The corpora as the tail of suites/search/corpora.yaml, after a marker line that scripts/pick-av.ts finds again. */
export const AV_MARKER = '# ---- audio and video (scripts/av-search-sets.ts): `file` is a clip, `title` is for display only'
export function avCorporaText(manifest: CorpusMedia[]): string {
  const c = avCorpora(manifest)
  return [AV_MARKER, ...Object.entries(c).map(([k, items]) => `${k}:\n${items.map((i) => `  - ${JSON.stringify(i)}`).join('\n')}`)].join('\n')
}

// ---- text -> sounds -------------------------------------------------------------------------------
const s = (...n: string[]) => n.map((x) => `snd-${x}`)

export const SOUND_QUERIES: Query[] = [
  { slug: 'dog-barking', query: 'a dog barking', relevant: s('canine-1'), how: `${UNSURE} ("Dog.ogg", assumed barking); the howl clip is left out` },
  { slug: 'dog-howling', query: 'a dog howling', relevant: s('canine-2'), how: `${FILE} ("Jem howls")` },
  { slug: 'cat-purring', query: 'a cat purring', relevant: s('cat-2', 'cat-3'), how: FILE },
  { slug: 'cat-meowing', query: 'a cat meowing', relevant: s('cat-1'), how: `${FILE} ("Meow of a pleading cat")` },
  { slug: 'rooster-crowing', query: 'a rooster crowing', relevant: s('farm-animal-1', 'farm-animal-2'), how: FILE },
  { slug: 'goats-bleating', query: 'goats bleating', relevant: s('farm-animal-3'), how: FILE },
  { slug: 'birds-singing', query: 'birds singing', relevant: s('bird-1', 'bird-2', 'bird-3'), how: FILE },
  { slug: 'blackbird-song', query: 'a blackbird singing', relevant: s('bird-1'), how: `${FILE}; the two dawn choruses are other birds`, hard: true },
  { slug: 'dawn-chorus', query: 'a dawn chorus of many birds', relevant: s('bird-2', 'bird-3'), how: `${FILE} ("dawn chorus"); the blackbird is one bird`, hard: true },
  { slug: 'bees-buzzing', query: 'bees buzzing', relevant: s('insect-1', 'insect-2'), how: FILE },
  { slug: 'frog-chorus', query: 'a chorus of frogs', relevant: s('frog-1', 'frog-2'), how: FILE },
  { slug: 'rain-falling', query: 'rain falling', relevant: s('rain-1', 'rain-2'), how: FILE },
  { slug: 'rain-on-window', query: 'rain against a window', relevant: s('rain-2'), how: `${FILE} ("Rain against the window"); the plain rain clip is a near miss`, hard: true },
  { slug: 'thunderstorm', query: 'thunder rumbling', relevant: s('thunder-1', 'thunder-2'), how: FILE },
  { slug: 'wind-howling', query: 'wind howling', relevant: s('wind-1', 'wind-2'), how: FILE },
  { slug: 'babbling-stream', query: 'a stream running over rocks', relevant: s('stream-1', 'stream-2'), how: `${FILE}; unsure about "Swale"; a tap is a near miss`, hard: true },
  { slug: 'ocean-waves', query: 'ocean waves crashing on a shore', relevant: s('sea-waves-1', 'sea-waves-2'), how: FILE },
  { slug: 'kitchen-sink', query: 'water running in a kitchen sink', relevant: s('running-water-1', 'running-water-2'), how: `${FILE}; a stream is a near miss`, hard: true },
  { slug: 'crackling-fire', query: 'a crackling fire', relevant: s('fire-1', 'fire-2'), how: FILE },
  { slug: 'helicopter', query: 'a helicopter flying overhead', relevant: s('helicopter-1', 'helicopter-2'), how: FILE },
  { slug: 'airplane', query: 'an airplane engine', relevant: s('airplane-1', 'airplane-2'), how: `${FILE}; a helicopter is a near miss`, hard: true },
  { slug: 'jet-takeoff', query: 'a jet airliner taking off', relevant: s('airplane-2'), how: `${UNSURE} ("Start einer Airbus A320"); the AN-24 clip is a propeller aircraft`, hard: true },
  { slug: 'motorbike', query: 'a motorbike engine', relevant: s('motorbike-1', 'motorbike-2'), how: FILE },
  { slug: 'train', query: 'a train on the tracks', relevant: s('train-1', 'train-2'), how: `${FILE}; the train videos are a different corpus`, hard: true },
  { slug: 'siren', query: 'a siren wailing', relevant: s('siren-1', 'siren-2'), how: FILE },
  { slug: 'police-siren', query: 'an American police siren', relevant: s('siren-2'), how: `${FILE} ("American police siren")`, hard: true },
  { slug: 'church-bells', query: 'church bells ringing', relevant: s('bell-1', 'bell-2'), how: FILE },
  { slug: 'ticking-clock', query: 'a clock ticking', relevant: s('clock-1', 'clock-2'), how: FILE },
  { slug: 'squeaky-door', query: 'a squeaky door', relevant: s('door-1'), how: `${FILE} ("Squeaky door"); the garage door is a near miss`, hard: true },
  { slug: 'garage-door', query: 'a garage door opening', relevant: s('door-2'), how: `${FILE} ("Garage door opening")` },
  { slug: 'typing', query: 'fast typing on a keyboard', relevant: s('typing-1', 'typing-2'), how: FILE },
  { slug: 'applause', query: 'an audience applauding', relevant: s('applause-1', 'applause-2'), how: FILE },
  { slug: 'frying', query: 'food frying in hot oil', relevant: s('cooking-1', 'cooking-2'), how: `${FILE} ("Frying fries", "Oil boiling")` },
  { slug: 'flute', query: 'a flute playing', relevant: s('flute-1', 'flute-2'), how: FILE },
  { slug: 'cymbal', query: 'a cymbal crash', relevant: s('percussion-1'), how: `${FILE} ("Cymbal sounds"); the tambourine is a near miss`, hard: true },
  { slug: 'tambourine', query: 'shaking a tambourine', relevant: s('percussion-2'), how: `${FILE} ("Tambourine")` },
  { slug: 'guitar', query: 'a guitar being played', relevant: s('guitar-1', 'guitar-2'), how: FILE },
  { slug: 'piano', query: 'solo piano music', relevant: s('piano-1', 'piano-2'), how: FILE },
]

// ---- text -> speech -------------------------------------------------------------------------------
const sp = (...n: string[]) => n.map((x) => `sp-${x}`)

const SUMMARY = "by the clip's summary (book, chapter and topic)"
export const SPEECH_QUERIES: Query[] = [
  { slug: 'bread-making', query: 'why good bread-making matters most in cooking, and home-made yeast', relevant: sp('cookery-bread'), how: SUMMARY },
  { slug: 'catching-shellfish', query: 'catching shellfish before cooking them', relevant: sp('cookery-fish'), how: SUMMARY },
  { slug: 'vegetable-garden', query: 'growing vegetables in a small garden plot', relevant: sp('gardening-vegetables'), how: SUMMARY },
  { slug: 'dew', query: 'where dew comes from', relevant: sp('weather-dew'), how: SUMMARY },
  { slug: 'sea-monster', query: 'a mysterious sea monster sighted by ships in 1866', relevant: sp('sea-nautilus'), how: SUMMARY },
  { slug: 'ishmael', query: 'a man who goes to sea because he has no money and nothing to keep him on shore', relevant: sp('sea-whaling'), how: SUMMARY },
  { slug: 'arctic-expedition', query: 'a British expedition sailing to the Arctic in 1875', relevant: sp('arctic-expedition'), how: SUMMARY },
  { slug: 'bird-plumage', query: 'how beautiful birds are and why they are hunted for their feathers', relevant: sp('birds-plumage'), how: SUMMARY },
  { slug: 'professor-lidenbrock', query: 'a nephew remembering his eccentric German professor uncle', relevant: sp('earth-journey'), how: SUMMARY },
  { slug: 'gun-club', query: 'a club of cannon enthusiasts in Baltimore after the war', relevant: sp('moon-gun-club'), how: SUMMARY },
  { slug: 'colorado-river', query: 'where the Colorado River begins in the Rocky Mountains', relevant: sp('river-colorado'), how: SUMMARY },
  { slug: 'candle-flame', query: 'a lecture on how a candle burns', relevant: sp('candle-lecture'), how: SUMMARY },
  { slug: 'roasting-meat', query: 'an old cookbook on roasting and boiling meat', relevant: sp('cookery-oldrecipes'), how: SUMMARY },
  { slug: 'heavens', query: 'early ideas about the sun, moon and stars', relevant: sp('astronomy-history'), how: SUMMARY },
  { slug: 'amber-electricity', query: 'electricity from rubbing amber', relevant: sp('electricity-friction'), how: SUMMARY },
  { slug: 'atlantic-cable', query: 'laying a telegraph cable across the Atlantic', relevant: sp('telegraph-cable'), how: SUMMARY },
  { slug: 'new-zealand-alps', query: 'climbing in the New Zealand Alps near Mount Cook', relevant: sp('alps-climbing'), how: SUMMARY },
  { slug: 'mason-bees', query: 'how mason bees build their nests', relevant: sp('bees-mason'), how: SUMMARY },
  { slug: 'volcano-theories', query: 'theories of how volcanoes work', relevant: sp('volcanoes-italy'), how: SUMMARY },
  { slug: 'san-francisco-earthquake', query: 'the 1906 San Francisco earthquake', relevant: sp('earthquake-sf'), how: SUMMARY },
  { slug: 'cooking-advice', query: 'cooking advice from old cookbooks', relevant: sp('cookery-bread', 'cookery-fish', 'cookery-oldrecipes'), how: `${SUMMARY}: the three cookery books`, hard: true },
  { slug: 'ships-and-the-sea', query: 'voyages at sea', relevant: sp('sea-nautilus', 'sea-whaling', 'arctic-expedition'), how: `${SUMMARY}: the three voyages; the telegraph cable crosses the sea but is not a voyage`, hard: true },
  { slug: 'earth-disasters', query: 'earthquakes and volcanoes', relevant: sp('volcanoes-italy', 'earthquake-sf'), how: SUMMARY, hard: true },
  { slug: 'animals-in-nature', query: 'studying animals in nature', relevant: sp('birds-plumage', 'bees-mason'), how: `${SUMMARY}: the bird and the bee books; unsure, a broad query`, hard: true },
]

// ---- text -> videos -------------------------------------------------------------------------------
const v = (...n: string[]) => n.map((x) => `vid-${x}`)

export const VIDEO_QUERIES: Query[] = [
  { slug: 'train-arriving', query: 'a train arriving at a station', relevant: v('train-2', 'train-3'), how: `${FILE} ("arriving at Malden Center"); the Tokyo train only passes a platform`, hard: true },
  { slug: 'train', query: 'a train on rails', relevant: v('train-1', 'train-2', 'train-3'), how: `${FILE}; the trams are a near miss, unsure` },
  { slug: 'tram-interior', query: 'the inside of a tram with empty seats', relevant: v('tram-2'), how: 'by its poster frame (seats and windows)' },
  { slug: 'rocket-launch', query: 'a rocket launching', relevant: v('rocket-launch-1', 'rocket-launch-2', 'rocket-launch-3'), how: `${FILE}; unsure, the posters of -1 and -3 are black or a title card` },
  { slug: 'ocean-waves', query: 'waves on the sea', relevant: v('sea-waves-1', 'sea-waves-2', 'sea-waves-3'), how: FILE },
  { slug: 'waterfall', query: 'a waterfall', relevant: v('waterfall-1', 'waterfall-2', 'waterfall-3'), how: `${FILE}; unsure about Watagataki Falls, its poster is a hillside` },
  { slug: 'horses', query: 'horses', relevant: v('horse-1', 'horse-2'), how: FILE },
  { slug: 'single-horse-grazing', query: 'a single horse eating grass', relevant: v('horse-1'), how: `${FILE}; the other clip is a distant herd`, hard: true },
  { slug: 'snowfall', query: 'snow falling', relevant: v('snow-1', 'snow-2'), how: FILE },
  { slug: 'snow-streetlight', query: 'snow falling at night under a street light', relevant: v('snow-2'), how: 'by file name and poster frame', hard: true },
  { slug: 'lightning', query: 'lightning in the night sky', relevant: v('lightning-1', 'lightning-2'), how: `${FILE}; unsure about "Megaflash", its poster is a lightning-mapper plot` },
  { slug: 'cat', query: 'a cat', relevant: v('cat-1', 'cat-3'), how: `${FILE}; the poster of cat-1 shows a room, the cat is out of frame` },
  { slug: 'cat-drinking', query: 'a cat drinking from a puddle', relevant: v('cat-3'), how: `${FILE} and poster; the jumping cat is a near miss`, hard: true },
  { slug: 'milk-on-stove', query: 'milk heating in a pot on a stove', relevant: v('cooking-1'), how: 'by poster frame ("Milchkochen")' },
  { slug: 'baking-cookies', query: 'cookies baking in the oven', relevant: v('cooking-3'), how: 'by poster frame and file name' },
  { slug: 'cooking', query: 'food being cooked', relevant: v('cooking-1', 'cooking-2', 'cooking-3'), how: FILE },
  { slug: 'cargo-ship', query: 'a cargo ship on a river', relevant: v('ship-1', 'ship-2'), how: `${FILE} (Danube, Elbe); the sea-wave clips are a near miss` },
  { slug: 'airplane', query: 'an aircraft taking off or landing', relevant: v('airplane-1', 'airplane-2'), how: `${FILE}; the Kolkata clip is shot from the aircraft` },
  { slug: 'city-from-air', query: 'a city seen from above through an aircraft window', relevant: v('airplane-1'), how: 'by poster frame', hard: true },
  { slug: 'bees-on-flowers', query: 'bees on purple flowers', relevant: v('insect-1'), how: 'by poster frame ("Bees on flowers")' },
  { slug: 'butterfly', query: 'a butterfly', relevant: v('insect-2'), how: `${FILE} ("Julia Butterfly")` },
  { slug: 'insects', query: 'insects', relevant: v('insect-1', 'insect-2'), how: FILE },
  { slug: 'road-traffic', query: 'cars driving on a street', relevant: v('traffic-1', 'traffic-3'), how: FILE },
  { slug: 'tram', query: 'a tram', relevant: v('tram-1', 'tram-2'), how: `${FILE}; unsure about tram-1, its poster is a meadow`, hard: true },
  { slug: 'clouds', query: 'clouds moving across the sky', relevant: v('clouds-1', 'clouds-2'), how: FILE },
  { slug: 'volcano', query: 'a volcano erupting', relevant: v('volcano-1'), how: FILE },
  { slug: 'sheep', query: 'sheep grazing in the countryside', relevant: v('cattle-2'), how: `${FILE} ("Sheep grazing in the countryside")` },
  { slug: 'cow', query: 'a cow', relevant: v('cattle-1'), how: `${FILE} ("Cow crosses cattle grid"); a night shot, unsure` },
  { slug: 'bird', query: 'a small colourful bird', relevant: v('bird-1'), how: 'by poster frame' },
]

// ---- clip -> clip ---------------------------------------------------------------------------------

/** Clips of one place or event, by original: each is the others' `scene` match. */
const SCENES: string[][] = [
  ['vid-train-2', 'vid-train-3'], // the same station, two arrivals
  ['vid-waterfall-1', 'vid-waterfall-2'], // the same falls, front and side
]

export interface ClipCase {
  id: string
  kind: 'sound-to-sound' | 'video-to-video'
  corpus: 'sounds-dup' | 'videos-dup'
  query: string
  expected: { copy: string[]; scene: string[]; class: string[] }
  relevant: string[]
  how: string
}

/** One case per copied clip: levels by original, as in scripts/pick-similarity.ts. */
export function clipCases(manifest: CorpusMedia[]): ClipCase[] {
  const out: ClipCase[] = []
  for (const parent of [...SOUND_COPY_PARENTS, ...VIDEO_COPY_PARENTS]) {
    const q = manifest.find((m) => m.id === parent)!
    const sound = q.kind === 'sound'
    const pool = manifest.filter((m) => m.kind === q.kind)
    const originalOf = (m: CorpusMedia) => m.derived_from ?? m.id
    const scene = new Set(SCENES.find((g) => g.includes(parent))?.filter((x) => x !== parent) ?? [])
    const level = (m: CorpusMedia): 'copy' | 'scene' | 'class' | null => {
      if (m.id === parent) return null
      const o = originalOf(m)
      if (o === parent) return 'copy'
      if (scene.has(o)) return 'scene'
      const om = pool.find((x) => x.id === o)!
      return om.category === q.category ? 'class' : null
    }
    const expected: ClipCase['expected'] = { copy: [], scene: [], class: [] }
    for (const m of pool) {
      const l = level(m)
      if (l) expected[l].push(m.id)
    }
    out.push({
      id: `${sound ? 'sound-to-sound' : 'video-to-video'}-${parent.replace(/^(snd|vid)-/, '')}`,
      kind: sound ? 'sound-to-sound' : 'video-to-video',
      corpus: sound ? 'sounds-dup' : 'videos-dup',
      query: parent,
      expected,
      relevant: [...expected.copy, ...expected.scene, ...expected.class].sort(),
      how: `levels by original: copy = its derived copies, ${scene.size > 0 ? 'scene = another clip of the same place, ' : ''}class = another clip of the same category (${q.category})`,
    })
  }
  return out
}
