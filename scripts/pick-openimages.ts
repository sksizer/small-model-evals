// Picks Open Images validation photos for the regions suites and writes their
// corpus entries and cases. The boxes are the dataset's own (CC BY 4.0), the
// photos CC BY 2.0; scripts/fetch-corpus.ts downloads and re-checks them.
//
//   bun scripts/pick-openimages.ts candidates [n]   contact sheets in .cache/openimages/
//   bun scripts/pick-openimages.ts write <job> <ImageID>...
//   bun scripts/pick-openimages.ts sensitive-candidates [perSheet] [sheets]   PNG contact sheets for the sensitive suite
//   bun scripts/pick-openimages.ts sensitive-write <category> <ImageID>...    corpus entries only
//
// `write` appends each photo to corpus/sources.yaml (id `oi-<job>-<ImageID>`)
// and writes suites/regions-<job>/cases/<id>.yaml from the dataset's boxes.
// Run scripts/fetch-corpus.ts afterwards. Review a contact sheet before
// writing: the filters below cannot see what a photo shows.
//
// Jobs:
// - objects: everyday things a fixed-class detector knows (COCO-like). A
//   photo qualifies with 2 to 8 boxes over at least 2 of the classes below.
// - find: one named thing an open-vocabulary detector is asked for; 1 to 4
//   boxes of a class that fixed-class detectors do not have.
// - faces: 1 to 6 human faces.
//
// Filters for every job: not rotated; no box in scope drawn as a group
// (IsGroupOf) or on a depiction (IsDepiction: a poster of a dog is not a
// dog); every box in scope at least MIN_AREA of the image; no Boy or Girl box
// anywhere in the photo.
//
// The sensitive suite (docs/plans/sensitive.md) uses `sensitive-candidates` and
// `sensitive-write` instead: SENSITIVE below lists, per category, the Open
// Images classes that make a photo a candidate and the labels that exclude it.
// The contact sheets are local PNGs (.cache/openimages/sensitive-<category>-<n>.png),
// each cell captioned with the image id and the photo's labels, to be looked at
// before anything is written. `sensitive-write` adds `oi-sens-<category>-<ImageID>`
// entries to corpus/sources.yaml; the cases are written by hand.
import { createHash } from 'node:crypto'
import sharp, { type OverlayOptions } from 'sharp'
import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OI_CACHE, OI_IMAGES, csvLine, oiLines } from './openimages.ts'
import { ROOT } from './ledger.ts'

const BOXES = 'https://storage.googleapis.com/openimages/v5/validation-annotations-bbox.csv'

type Job = 'objects' | 'find' | 'faces'
/** Open Images class name → the label synonyms a case lists (first one is the `find` phrase). */
const CLASSES: Record<Job, Record<string, string[]>> = {
  objects: {
    Laptop: ['laptop'],
    'Coffee cup': ['cup', 'coffee cup', 'mug'],
    Mug: ['cup', 'mug'],
    Book: ['book'],
    Chair: ['chair'],
    Bottle: ['bottle'],
    'Mobile phone': ['cell phone', 'mobile phone', 'phone'],
    Dog: ['dog'],
    Cat: ['cat'],
    Bicycle: ['bicycle', 'bike'],
    Car: ['car'],
    'Computer keyboard': ['keyboard'],
    Houseplant: ['potted plant', 'houseplant', 'plant'],
    Television: ['tv', 'television'],
    Clock: ['clock'],
    Couch: ['couch', 'sofa'],
    Bench: ['bench'],
    'Wine glass': ['wine glass'],
    Bowl: ['bowl'],
    Umbrella: ['umbrella'],
  },
  find: {
    Whiteboard: ['whiteboard'],
    Poster: ['poster'],
    'Traffic sign': ['traffic sign', 'road sign', 'sign'],
    Sunglasses: ['sunglasses'],
    'Picture frame': ['picture frame', 'frame'],
    Calculator: ['calculator'],
    Pen: ['pen'],
    Lamp: ['lamp'],
    Mirror: ['mirror'],
    Guitar: ['guitar'],
    Billboard: ['billboard'],
    'Bicycle helmet': ['bicycle helmet', 'helmet'],
    Watch: ['watch', 'wristwatch'],
    Envelope: ['envelope'],
  },
  faces: { 'Human face': ['face', 'human face'] },
}
const LIMITS: Record<Job, { min: number; max: number; distinct: number }> = {
  objects: { min: 2, max: 8, distinct: 2 },
  find: { min: 1, max: 4, distinct: 1 },
  faces: { min: 1, max: 6, distinct: 1 },
}
const MIN_AREA = 0.004
const EXCLUDE = new Set(['Boy', 'Girl'])

interface OiBox {
  cls: string
  box: [number, number, number, number]
  group: boolean
  depiction: boolean
}

/** A box in scope: one object, with every class the dataset gave it. */
interface Region {
  classes: string[]
  labels: string[]
  box: [number, number, number, number]
}

const iou = (a: OiBox['box'], b: OiBox['box']) => {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
  const inter = ix * iy
  return inter / (area(a) + area(b) - inter)
}

async function load() {
  const names = new Map(
    (await oiLines('https://storage.googleapis.com/openimages/v7/oidv7-class-descriptions-boxable.csv')).map((l) => csvLine(l) as [string, string]),
  )
  const byImage = new Map<string, OiBox[]>()
  const [head, ...lines] = await oiLines(BOXES)
  const col = Object.fromEntries(csvLine(head!).map((c, i) => [c, i]))
  for (const l of lines) {
    const v = csvLine(l)
    const id = v[col['ImageID']!]!
    const box: OiBox = {
      cls: names.get(v[col['LabelName']!]!) ?? v[col['LabelName']!]!,
      box: [col['XMin'], col['YMin'], col['XMax'], col['YMax']].map((i) => Number(v[i!])) as OiBox['box'],
      group: v[col['IsGroupOf']!] === '1',
      depiction: v[col['IsDepiction']!] === '1',
    }
    byImage.set(id, [...(byImage.get(id) ?? []), box])
  }
  const [ihead, ...ilines] = await oiLines(OI_IMAGES)
  const icol = Object.fromEntries(csvLine(ihead!).map((c, i) => [c, i]))
  const images = new Map(
    ilines.map((l) => {
      const v = csvLine(l)
      return [v[0]!, { rotation: Number(v[icol['Rotation']!] || 0), title: v[icol['Title']!]! }]
    }),
  )
  return { byImage, images }
}

const area = (b: OiBox['box']) => (b[2] - b[0]) * (b[3] - b[1])

/** The boxes in scope for a job, or null when the photo does not qualify. */
function qualify(job: Job, boxes: OiBox[], rotation: number): Region[] | null {
  if (rotation !== 0) return null
  if (boxes.some((b) => EXCLUDE.has(b.cls))) return null
  const inScope = boxes.filter((b) => b.cls in CLASSES[job])
  if (inScope.some((b) => b.group || b.depiction || area(b.box) < MIN_AREA)) return null
  // The dataset sometimes boxes one object under two classes (Mug and Coffee
  // cup, Chair and Couch); boxes of different classes that overlap at
  // IoU >= 0.8 are one object with both classes' labels.
  const regions: Region[] = []
  for (const b of inScope) {
    const same = regions.find((r) => !r.classes.includes(b.cls) && iou(r.box, b.box) >= 0.8)
    if (same) {
      same.classes.push(b.cls)
      same.labels = [...new Set([...same.labels, ...CLASSES[job][b.cls]!])]
    } else regions.push({ classes: [b.cls], labels: [...CLASSES[job][b.cls]!], box: b.box })
  }
  const { min, max, distinct } = LIMITS[job]
  if (regions.length < min || regions.length > max) return null
  const kinds = new Set(regions.map((r) => r.labels[0]))
  if (kinds.size < distinct) return null
  // A find case asks for one thing.
  if (job === 'find' && kinds.size !== 1) return null
  return regions
}

const order = (id: string) => createHash('sha256').update(id).digest('hex')

async function candidates(n: number) {
  const { byImage, images } = await load()
  for (const job of Object.keys(CLASSES) as Job[]) {
    const picked: { id: string; boxes: Region[] }[] = []
    // For find, spread the picks over the classes.
    const perClass = new Map<string, number>()
    for (const id of [...byImage.keys()].sort((a, b) => order(a).localeCompare(order(b)))) {
      const img = images.get(id)
      if (!img) continue
      const boxes = qualify(job, byImage.get(id)!, img.rotation)
      if (!boxes) continue
      if (job === 'find') {
        const c = boxes[0]!.classes[0]!
        if ((perClass.get(c) ?? 0) >= Math.ceil(n / Object.keys(CLASSES.find).length) + 1) continue
        perClass.set(c, (perClass.get(c) ?? 0) + 1)
      }
      picked.push({ id, boxes })
      if (picked.length >= n) break
    }
    mkdirSync(OI_CACHE, { recursive: true })
    writeFileSync(join(OI_CACHE, `candidates-${job}.json`), JSON.stringify(picked, null, 1))
    const cells = picked
      .map(
        (p) =>
          `<figure><div class="f"><img loading="lazy" src="https://s3.amazonaws.com/open-images-dataset/validation/${p.id}.jpg">${p.boxes
            .map(
              (b) =>
                `<i style="left:${b.box[0] * 100}%;top:${b.box[1] * 100}%;width:${(b.box[2] - b.box[0]) * 100}%;height:${(b.box[3] - b.box[1]) * 100}%"></i>`,
            )
            .join('')}</div><figcaption>${p.id}<br>${[...new Set(p.boxes.map((b) => b.classes.join('/')))].join(', ')} (${p.boxes.length})</figcaption></figure>`,
      )
      .join('')
    writeFileSync(
      join(OI_CACHE, `sheet-${job}.html`),
      `<!doctype html><meta charset=utf-8><style>body{font:11px sans-serif;display:grid;grid-template-columns:repeat(6,1fr);gap:6px;margin:6px}figure{margin:0}.f{position:relative}img{width:100%;display:block}i{position:absolute;border:2px solid #f0f;box-sizing:border-box}</style>${cells}`,
    )
    console.log(`${job}: ${picked.length} candidates → .cache/openimages/sheet-${job}.html`)
  }
}

const yamlList = (xs: string[]) => `[${xs.map((x) => (/^[a-z0-9 -]+$/.test(x) ? x : JSON.stringify(x))).join(', ')}]`
const r4 = (n: number) => Math.round(n * 10000) / 10000

async function write(job: Job, ids: string[]) {
  const { byImage, images } = await load()
  const dir = join(ROOT, 'suites', `regions-${job}`, 'cases')
  mkdirSync(dir, { recursive: true })
  const sources = join(ROOT, 'corpus', 'sources.yaml')
  for (const oi of ids) {
    const img = images.get(oi)
    const boxes = img && qualify(job, byImage.get(oi) ?? [], img.rotation)
    if (!boxes) throw new Error(`${oi} does not qualify for ${job}`)
    const id = `oi-${job}-${oi}`
    const casePath = join(dir, `${id}.yaml`)
    if (existsSync(casePath)) throw new Error(`${casePath} exists; cases are immutable`)
    const find = [...new Set(boxes.map((b) => b.labels[0]!))]
    const lines = [
      `description: ${JSON.stringify(`${job}: ${[...new Set(boxes.map((b) => b.classes.join('/').toLowerCase()))].join(', ')} (Open Images ${oi})`)}`,
      `metadata: { id: ${id} }`,
      'vars:',
      `  image: file://../../corpus/images/${id}.jpg`,
      `  find: ${yamlList(find)}`,
      '  expected:',
      '    boxes:',
      ...boxes.map((b) => `      - { label: ${yamlList(b.labels)}, box: [${b.box.map(r4).join(', ')}] }`),
    ]
    writeFileSync(casePath, `${lines.join('\n')}\n`)
    appendFileSync(sources, `- { id: ${id}, category: regions-${job}, openimages: '${oi}' }\n`)
    console.log(`${id}: ${boxes.length} boxes`)
  }
}

// ---- sensitive suite ----

const LABELS = 'https://storage.googleapis.com/openimages/v5/validation-annotations-human-imagelabels.csv'
const CLASS_NAMES = 'https://storage.googleapis.com/openimages/v7/oidv7-class-descriptions.csv'
const SENSITIVE_URL = (id: string) => `https://s3.amazonaws.com/open-images-dataset/validation/${id}.jpg`

/** Labels that mean a child may be in the photo. */
const CHILD = ['Boy', 'Girl', 'Child', 'Baby', 'Toddler', 'Infant']
/** Labels that make a photo unfit for the `minor` category (and for the others when it also shows a child). */
const INTIMATE_ADJACENT = ['Swimwear', 'Bikini', 'Brassiere', 'Underpants', 'Undergarment', 'Lingerie', 'Swim cap', 'Bed', 'Bedroom', 'Bathroom', 'Bathtub', 'Toilet', 'Shower', 'Swimming pool', 'Beach', 'Nudity', 'Bidet', 'Bathing']

interface SensitiveJob {
  /** Any of these classes (boxes, or image-level labels with confidence 1) makes the photo a candidate. */
  any: string[]
  /** The photo must have none of these labels. */
  none: string[]
  /** For box classes in `any`: the largest box must cover at least this much of the photo. */
  minArea?: number
  /** The photo must also have all of these labels (the dataset's Boy and Girl boxes often sit on adults). */
  need?: string[]
  /** At most this many boxes of the first class in `any`. */
  maxBoxes?: number
}
const SENSITIVE: Record<string, SensitiveJob> = {
  face: { any: ['Human face'], none: [...CHILD, ...INTIMATE_ADJACENT], minArea: 0.04, maxBoxes: 1 },
  plate: { any: ['Vehicle registration plate'], none: [...CHILD, ...INTIMATE_ADJACENT], minArea: 0.002 },
  house: { any: ['House'], none: [...CHILD, ...INTIMATE_ADJACENT], minArea: 0.15 },
  sign: { any: ['Traffic sign', 'Street light'], none: [...CHILD, ...INTIMATE_ADJACENT], minArea: 0.03 },
  screen: { any: ['Mobile phone', 'Laptop', 'Computer monitor'], none: [...CHILD, ...INTIMATE_ADJACENT], minArea: 0.1 },
  medical: { any: ['Medical equipment'], none: [...CHILD, ...INTIMATE_ADJACENT], minArea: 0.05 },
  intimate: { any: ['Brassiere', 'Lingerie', 'Underpants', 'Undergarment'], none: [...CHILD, 'Nudity'] },
  minor: { any: ['Boy', 'Girl'], need: ['Child'], none: INTIMATE_ADJACENT, minArea: 0.03 },
  swimwear: { any: ['Swimwear', 'Bikini'], none: [...CHILD, 'Brassiere', 'Underpants', 'Lingerie', 'Nudity'] },
  scene: { any: ['Landscape', 'Mountain', 'Beach', 'Crowd'], none: [...CHILD, ...INTIMATE_ADJACENT.filter((x) => x !== 'Beach'), 'Human face', 'Person'] },
}

async function sensitiveCandidates(perSheet: number, sheets: number) {
  const { byImage, images } = await load()
  const names = new Map((await oiLines(CLASS_NAMES)).map((l) => csvLine(l) as [string, string]))
  const labelsByImage = new Map<string, Set<string>>()
  const [lhead, ...llines] = await oiLines(LABELS)
  const lcol = Object.fromEntries(csvLine(lhead!).map((c, i) => [c, i]))
  for (const l of llines) {
    const v = csvLine(l)
    if (v[lcol['Confidence']!] !== '1') continue
    const id = v[lcol['ImageID']!]!
    const set = labelsByImage.get(id) ?? new Set()
    set.add(names.get(v[lcol['LabelName']!]!) ?? v[lcol['LabelName']!]!)
    labelsByImage.set(id, set)
  }
  const thumbs = join(OI_CACHE, 'thumbs')
  mkdirSync(thumbs, { recursive: true })
  for (const [category, job] of Object.entries(SENSITIVE)) {
    if (process.env['ONLY'] && process.env['ONLY'] !== category) continue
    const picked: { id: string; labels: string[] }[] = []
    for (const id of [...images.keys()].sort((a, b) => order(a + category).localeCompare(order(b + category)))) {
      if (images.get(id)!.rotation !== 0) continue
      const boxes = byImage.get(id) ?? []
      const labels = new Set([...(labelsByImage.get(id) ?? []), ...boxes.map((b) => b.cls)])
      if (job.none.some((x) => labels.has(x))) continue
      if (job.need?.some((x) => !labels.has(x))) continue
      const hits = boxes.filter((b) => job.any.includes(b.cls))
      if (hits.length === 0 && !job.any.some((x) => labelsByImage.get(id)?.has(x))) continue
      if (job.minArea && hits.length > 0 && (hits.some((b) => b.group || b.depiction) || Math.max(...hits.map((b) => area(b.box))) < job.minArea)) continue
      if (job.minArea && hits.length === 0) continue
      if (job.maxBoxes && hits.filter((b) => b.cls === job.any[0]).length > job.maxBoxes) continue
      picked.push({ id, labels: [...labels].sort() })
      if (picked.length >= perSheet * sheets) break
    }
    const cellW = 320
    const cellH = 270
    for (let s = 0; s < sheets; s++) {
      const part = picked.slice(s * perSheet, (s + 1) * perSheet)
      if (part.length === 0) continue
      const cols = 4
      const rows = Math.ceil(part.length / cols)
      const composites: OverlayOptions[] = []
      for (const [i, p] of part.entries()) {
        const file = join(thumbs, `${p.id}.jpg`)
        if (!existsSync(file)) {
          const res = await fetch(SENSITIVE_URL(p.id))
          if (!res.ok) continue
          writeFileSync(file, await sharp(new Uint8Array(await res.arrayBuffer())).resize(cellW, cellH - 40, { fit: 'inside' }).jpeg({ quality: 80 }).toBuffer())
        }
        const x = (i % cols) * cellW
        const y = Math.floor(i / cols) * cellH
        composites.push({ input: file, left: x, top: y })
        const caption = `${p.id.slice(0, 8)} ${p.labels.slice(0, 7).join(',')}`.replace(/[<>&]/g, '')
        composites.push({
          input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${cellW}" height="38"><text x="2" y="14" font-size="13" font-family="Helvetica" fill="#000">${caption.slice(0, 48)}</text><text x="2" y="30" font-size="11" font-family="Helvetica" fill="#444">${caption.slice(48, 100)}</text></svg>`),
          left: x,
          top: y + cellH - 38,
        })
      }
      const out = join(OI_CACHE, `sensitive-${category}-${s + 1}.png`)
      await sharp({ create: { width: cols * cellW, height: rows * cellH, channels: 3, background: '#fff' } }).composite(composites).png().toFile(out)
      console.log(`${category}: sheet ${s + 1} → ${out} (${part.map((p) => p.id.slice(0, 8)).join(' ')})`)
    }
    writeFileSync(join(OI_CACHE, `sensitive-${category}.json`), JSON.stringify(picked, null, 1))
  }
}

/** Adds corpus entries for chosen photos; the full id is looked up by prefix in the candidate list. */
async function sensitiveWrite(category: string, ids: string[]) {
  const sources = join(ROOT, 'corpus', 'sources.yaml')
  const pool = JSON.parse(readFileSync(join(OI_CACHE, `sensitive-${category}.json`), 'utf8')) as { id: string }[]
  for (const prefix of ids) {
    const found = pool.filter((p) => p.id.startsWith(prefix))
    if (found.length !== 1) throw new Error(`${prefix}: ${found.length} candidates in ${category}`)
    const oi = found[0]!.id
    const sensitive = category === 'minor' || category === 'intimate' ? ', sensitive: true' : ''
    appendFileSync(sources, `- { id: oi-sens-${category}-${oi}, category: sensitive-${category}${sensitive}, openimages: '${oi}' }\n`)
    console.log(`oi-sens-${category}-${oi}`)
  }
}

const [cmd, ...rest] = process.argv.slice(2)
if (cmd === 'candidates') await candidates(Number(rest[0] ?? 24))
else if (cmd === 'write') await write(rest[0] as Job, rest.slice(1))
else if (cmd === 'sensitive-candidates') await sensitiveCandidates(Number(rest[0] ?? 12), Number(rest[1] ?? 3))
else if (cmd === 'sensitive-write') await sensitiveWrite(rest[0]!, rest.slice(1))
else throw new Error('usage: pick-openimages.ts candidates [n] | write <objects|find|faces> <ImageID>... | sensitive-candidates [perSheet] [sheets] | sensitive-write <category> <ImageID>...')
