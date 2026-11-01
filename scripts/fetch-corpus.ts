// Builds the image corpus listed in corpus/sources.yaml. An entry is one of:
//
// - a Wikimedia Commons file (`title`). The script re-reads its licence,
//   refuses anything outside the allow-list (CC0, public domain, CC BY; no
//   share-alike) and saves a 768 px JPEG to corpus/images/<id>.jpg.
// - an Open Images validation photo (`openimages: <ImageID>`), CC BY 2.0,
//   for the regions suites, whose boxes come from Open Images too. Its
//   licence and author come from the dataset's image list (downloaded once
//   into .cache/openimages/); the photo comes from the dataset's mirror and
//   is re-encoded at 768 px with every metadata block (EXIF, GPS) dropped.
// - a synthetic page (`synthetic: synthetic/<file>.html`, `size: [w, h]`),
//   rendered once with headless Chrome to corpus/images/<id>.png. Its text is
//   known exactly, which OCR cases need. Set CHROME to the browser binary if
//   the script cannot find one.
//
// Each image's source, author, licence and sha256 go in corpus/manifest.json;
// ATTRIBUTIONS.md is generated from it (CC BY requires it). Images already in
// the manifest are kept, so a rerun only adds new entries. An image whose
// bytes changed is an error: cases name images by id, so a changed image
// needs a new id.
//
//   bun scripts/fetch-corpus.ts
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnRunner } from '@osdlc/command-seam'
import sharp from 'sharp'
import { ROOT, SCOPE } from './ledger.ts'
import { OI_LICENCE, oiImage } from './openimages.ts'
import { chrome } from './chrome.ts'

// EVALS_SCOPE=private builds private/corpus (gitignored) the same way.
const CORPUS = SCOPE === 'private' ? join(ROOT, 'private', 'corpus') : join(ROOT, 'corpus')
const IMAGES = join(CORPUS, 'images')
const MANIFEST = join(CORPUS, 'manifest.json')
const WIDTH = 768
const UA = 'small-model-evals/0.1 (local eval corpus; https://github.com/sksizer/small-model-evals)'
const ALLOWED = /^(CC0( 1\.0)?|Public domain|PD\b.*|CC BY \d(\.\d)?)$/i

// `sensitive: true` marks an image the site shows blurred until the viewer
// asks to see it (nudity, including in art). It is display metadata, so it
// can change on an existing entry without a new id.
type Source = { id: string; category: string; sensitive?: boolean } & (
  | { title: string }
  | { synthetic: string; size: [number, number] }
  | { openimages: string }
)
export interface CorpusImage {
  id: string
  category: string
  file: string
  title: string
  page: string
  author: string
  licence: string
  licence_url: string | null
  width: number
  height: number
  sha256: string
  sensitive?: true
}

type ExtMeta = Record<string, { value: string } | undefined>
interface ImageInfo { descriptionurl: string; thumburl: string; thumbwidth: number; thumbheight: number; extmetadata?: ExtMeta }

const stripHtml = (s: string) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

async function api(params: Record<string, string>): Promise<unknown> {
  const url = new URL('https://commons.wikimedia.org/w/api.php')
  for (const [k, v] of Object.entries({ action: 'query', format: 'json', ...params })) url.searchParams.set(k, v)
  for (let attempt = 0; attempt < 3; attempt++) {
    await Bun.sleep(2500)
    const res = await fetch(url, { headers: { 'User-Agent': UA } })
    const text = await res.text()
    if (text.startsWith('{')) return JSON.parse(text)
    await Bun.sleep(30_000) // rate limited
  }
  throw new Error(`Commons API kept refusing: ${url}`)
}

async function download(url: string): Promise<Uint8Array> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await Bun.sleep(2500)
    const res = await fetch(url, { headers: { 'User-Agent': UA } })
    if (res.ok) return new Uint8Array(await res.arrayBuffer())
    if (res.status !== 429) throw new Error(`${url}: HTTP ${res.status}`)
    await Bun.sleep(30_000)
  }
  throw new Error(`${url}: kept rate-limiting`)
}

function render(html: string, size: [number, number], out: string): Uint8Array {
  const res = spawnRunner(chrome()).run(
    ['--headless', '--hide-scrollbars', '--force-device-scale-factor=1', `--window-size=${size[0]},${size[1]}`, `--screenshot=${out}`, `file://${html}`],
    { cwd: ROOT },
  )
  if (!existsSync(out)) throw new Error(`rendering ${html} failed: ${res.stderr}`)
  return new Uint8Array(readFileSync(out))
}

const sources = Bun.YAML.parse(readFileSync(join(CORPUS, 'sources.yaml'), 'utf8')) as Source[]
const ids = new Set<string>()
for (const s of sources) {
  if (!/^[a-z0-9-]+$/.test(s.id)) throw new Error(`bad id ${s.id}`)
  if (ids.has(s.id)) throw new Error(`duplicate id ${s.id}`)
  ids.add(s.id)
}

const manifest: CorpusImage[] = existsSync(MANIFEST) ? (JSON.parse(readFileSync(MANIFEST, 'utf8')) as CorpusImage[]) : []
const known = new Map(manifest.map((m) => [m.id, m]))
mkdirSync(IMAGES, { recursive: true })

const failures: string[] = []
for (const s of sources) {
  const have = known.get(s.id)
  const sameSource = (title: string) =>
    'openimages' in s ? title.startsWith(`Open Images ${s.openimages}:`) : title === ('title' in s ? s.title : s.synthetic)
  if (have) {
    if (s.sensitive) have.sensitive = true
    else delete have.sensitive
    const path = join(CORPUS, have.file)
    if (!sameSource(have.title)) failures.push(`${s.id}: source changed; give the new image a new id`)
    else if (!existsSync(path)) failures.push(`${s.id}: in the manifest but corpus/${have.file} is missing`)
    else if (createHash('sha256').update(readFileSync(path)).digest('hex') !== have.sha256) failures.push(`${s.id}: image bytes changed`)
    continue
  }
  if ('openimages' in s) {
    const row = await oiImage(s.openimages)
    if (!row) {
      failures.push(`${s.id}: Open Images validation has no image ${s.openimages}`)
      continue
    }
    if (row['License'] !== OI_LICENCE) {
      failures.push(`${s.id}: licence ${row['License']} is not CC BY 2.0`)
      continue
    }
    if (row['Rotation'] && Number(row['Rotation']) !== 0) {
      failures.push(`${s.id}: rotated ${row['Rotation']} degrees; its boxes would not line up`)
      continue
    }
    const original = await download(`https://s3.amazonaws.com/open-images-dataset/validation/${s.openimages}.jpg`)
    // No .rotate() and no .withMetadata(): pixels stay as annotated, and EXIF/GPS are dropped.
    const { data: bytes, info } = await sharp(original).resize({ width: WIDTH, withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer({ resolveWithObject: true })
    const path = join(IMAGES, `${s.id}.jpg`)
    writeFileSync(path, bytes)
    manifest.push({
      id: s.id,
      category: s.category,
      file: `images/${s.id}.jpg`,
      title: `Open Images ${s.openimages}: ${row['Title'] || 'untitled'}`,
      page: row['OriginalLandingURL']!,
      author: row['Author'] || 'unknown',
      licence: 'CC BY 2.0',
      licence_url: OI_LICENCE,
      width: info.width,
      height: info.height,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      ...(s.sensitive ? { sensitive: true as const } : {}),
    })
    console.log(`${s.id}: Open Images ${s.openimages}, ${info.width}x${info.height}`)
    continue
  }
  if ('synthetic' in s) {
    const file = `images/${s.id}.png`
    const bytes = render(join(CORPUS, s.synthetic), s.size, join(CORPUS, file))
    manifest.push({
      id: s.id,
      category: s.category,
      file,
      title: s.synthetic,
      page: s.synthetic,
      author: 'Synthetic (invented details)',
      licence: 'CC0',
      licence_url: 'https://creativecommons.org/publicdomain/zero/1.0/',
      width: s.size[0],
      height: s.size[1],
      sha256: createHash('sha256').update(bytes).digest('hex'),
      ...(s.sensitive ? { sensitive: true as const } : {}),
    })
    console.log(`${s.id}: rendered ${s.size.join('x')}`)
    continue
  }
  const path = join(IMAGES, `${s.id}.jpg`)
  const res = (await api({ titles: s.title, prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: String(WIDTH) })) as {
    query?: { pages?: Record<string, { missing?: string; imageinfo?: ImageInfo[] }> }
  }
  const page = Object.values(res.query?.pages ?? {})[0]
  const info = page?.imageinfo?.[0]
  if (!info) {
    failures.push(`${s.id}: ${s.title} not found on Commons`)
    continue
  }
  const meta = info.extmetadata ?? {}
  const licence = stripHtml(meta['LicenseShortName']?.value ?? '')
  if (!ALLOWED.test(licence)) {
    failures.push(`${s.id}: licence "${licence}" is not on the allow-list`)
    continue
  }
  const bytes = await download(info.thumburl)
  writeFileSync(path, bytes)
  const image: CorpusImage = {
    id: s.id,
    category: s.category,
    file: `images/${s.id}.jpg`,
    title: s.title,
    page: info.descriptionurl,
    author: stripHtml(meta['Artist']?.value ?? '') || 'unknown',
    licence,
    licence_url: meta['LicenseUrl']?.value ?? null,
    width: info.thumbwidth,
    height: info.thumbheight,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...(s.sensitive ? { sensitive: true as const } : {}),
  }
  manifest.push(image)
  console.log(`${s.id}: ${licence}, ${info.thumbwidth}x${info.thumbheight}`)
}

const order = new Map(sources.map((s, i) => [s.id, i]))
manifest.sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9))
writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)

const lines = [
  '# Attributions',
  '',
  'Generated by `scripts/fetch-corpus.ts` from `manifest.json`; do not edit.',
  'Images are 768 px renditions of the Wikimedia Commons files and Open Images photos linked below, or synthetic pages (CC0).',
  '',
  '| Image | Source | Author | Licence |',
  '| --- | --- | --- | --- |',
  ...manifest.map((m) => {
    const cell = (s: string) => s.replace(/\|/g, '\\|')
    // A bare domain in an author credit would read as a link; quote it.
    const credit = (s: string) => cell(s).replace(/\b(?:https?:\/\/|www\.)\S+/g, (u) => `\`${u}\``)
    const lic = m.licence_url ? `[${m.licence}](${m.licence_url})` : m.licence
    return `| \`${m.id}\` | [${cell(m.title.replace(/^File:/, ''))}](${m.page}) | ${credit(m.author)} | ${lic} |`
  }),
  '',
]
writeFileSync(join(CORPUS, 'ATTRIBUTIONS.md'), lines.join('\n'))

if (failures.length > 0) {
  console.error(failures.map((f) => `- ${f}`).join('\n'))
  process.exit(1)
}
console.log(`ok: ${manifest.length} images`)
