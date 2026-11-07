// Builds the audio and video corpus listed in corpus/av-sources.yaml, for
// scripts/fetch-corpus.ts (which calls fetchAv and writes the attributions). An
// entry has an `id`, a `kind`, a `category` (what is in it: the clip-to-clip
// `class` level groups clips by it) and one source:
//
// - a Wikimedia Commons file (`title`), sound or video. Its licence is read
//   from the file page and checked against the allow-list, as for images.
// - a LibriVox chapter (`librivox: <archive.org item>`, `file: <name>`), speech.
//   The item's metadata must say it is public domain or CC0 (`licenseurl`), and
//   sit in the librivoxaudio collection.
//
// `start` and `duration` (seconds) pick the segment. `kind` is `sound`, `speech`
// or `video`; each is converted with ffmpeg (scripts/ffmpeg.ts) into the stored
// format of docs/standards/corpus.md: sound and speech as 16 kHz mono Opus in
// audio/<id>.ogg, video as 360p H.264 with no sound track in video/<id>.mp4.
// Speech also carries a `summary` (one line) and, where the book's text could be
// matched, an approximate `transcript`.
//
// Freesound is in the standard (CC0 only) but not fetched here: its API needs a
// key. The Freesound files that Commons hosts come in as Commons files.
//
// Each clip's source, author, licence and sha256 go in corpus/av-manifest.json.
// A clip already in the manifest is kept; one whose bytes, start or duration
// changed is an error, since cases name clips by id.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { UA, api, stripHtml } from './commons.ts'
import { AUDIO_EXT, VIDEO_EXT, probe, toAudio, toVideo } from './ffmpeg.ts'
import { ALLOWED } from './licences.ts'

export type MediaKind = 'sound' | 'speech' | 'video'

type MediaSource = { id: string; kind: MediaKind; category: string; start?: number; duration?: number; summary?: string; transcript?: string } & (
  | { title: string }
  | { librivox: string; file: string }
)

/** One stored clip: corpus/av-manifest.json. */
export interface CorpusMedia {
  id: string
  kind: MediaKind
  category: string
  /** Path under corpus/. */
  file: string
  /** `File:...` on Commons, or `LibriVox <item>/<file>: <book>, <chapter>`. */
  title: string
  page: string
  author: string
  licence: string
  licence_url: string | null
  /** Where in the source the clip starts, and its length in the stored file, in seconds. */
  start: number
  duration: number
  bytes: number
  sha256: string
  width?: number
  height?: number
  summary?: string
  /** Speech only: the book text this clip reads, approximate (see av-sources.yaml). */
  transcript?: string
}

/** Allowed stored length in seconds, per kind (docs/standards/corpus.md). */
export const LENGTH: Record<MediaKind, [number, number]> = { sound: [5, 30], speech: [60, 120], video: [5, 15] }
const DEFAULT_LENGTH: Record<MediaKind, number> = { sound: 20, speech: 90, video: 10 }
const KBPS = { sound: 24, speech: 16 }

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

interface Located {
  url: string
  /** Seconds in the source, when known. */
  length: number | null
  title: string
  page: string
  author: string
  licence: string
  licence_url: string | null
}

type ExtMeta = Record<string, { value: string } | undefined>
interface CommonsInfo { url: string; descriptionurl: string; duration?: number; extmetadata?: ExtMeta }

async function commons(s: MediaSource & { title: string }): Promise<Located | string> {
  const res = (await api({ titles: s.title, prop: 'imageinfo', iiprop: 'url|extmetadata|size' })) as {
    query?: { pages?: Record<string, { imageinfo?: CommonsInfo[] }> }
  }
  const info = Object.values(res.query?.pages ?? {})[0]?.imageinfo?.[0]
  if (!info) return `${s.title} not found on Commons`
  const meta = info.extmetadata ?? {}
  const licence = stripHtml(meta['LicenseShortName']?.value ?? '')
  if (!ALLOWED.test(licence)) return `licence "${licence}" is not on the allow-list`
  return {
    url: info.url,
    length: info.duration ?? null,
    title: s.title,
    page: info.descriptionurl,
    author: stripHtml(meta['Artist']?.value ?? '') || 'unknown',
    licence,
    licence_url: meta['LicenseUrl']?.value ?? null,
  }
}

interface ArchiveMeta {
  metadata?: { licenseurl?: string; creator?: string | string[]; title?: string; collection?: string | string[] }
  files?: { name: string; title?: string; length?: string }[]
}

/** archive.org file lengths come as seconds ("512.3") or clock time ("36:35", "1:02:03"). */
const seconds = (length: string): number => length.split(':').reduce((t, part) => t * 60 + Number(part), 0)

/** The licence an archive.org item states, as our manifest names it, or null when it is not public domain / CC0. */
function archiveLicence(url: string | undefined): { licence: string; licence_url: string } | null {
  if (!url) return null
  if (/creativecommons\.org\/publicdomain\/zero\/1\.0/.test(url)) return { licence: 'CC0', licence_url: url }
  if (/creativecommons\.org\/(publicdomain\/mark\/1\.0|licenses\/publicdomain)/.test(url)) return { licence: 'Public domain', licence_url: url }
  return null
}

async function librivox(s: MediaSource & { librivox: string; file: string }): Promise<Located | string> {
  await Bun.sleep(2500)
  const res = await fetch(`https://archive.org/metadata/${s.librivox}`, { headers: { 'User-Agent': UA } })
  if (!res.ok) return `archive.org item ${s.librivox}: HTTP ${res.status}`
  const j = (await res.json()) as ArchiveMeta
  const m = j.metadata
  if (!m) return `archive.org has no item ${s.librivox}`
  const collections = [m.collection ?? []].flat()
  if (!collections.includes('librivoxaudio')) return `${s.librivox} is not in the librivoxaudio collection`
  const lic = archiveLicence(m.licenseurl)
  if (!lic) return `${s.librivox} states licence "${m.licenseurl ?? 'none'}", not public domain or CC0`
  const file = j.files?.find((f) => f.name === s.file)
  if (!file) return `${s.librivox} has no file ${s.file}`
  const creator = [m.creator ?? []].flat().join('; ') || 'unknown'
  return {
    url: `https://archive.org/download/${s.librivox}/${encodeURIComponent(s.file)}`,
    length: file.length ? seconds(file.length) : null,
    title: `LibriVox ${s.librivox}/${s.file}: ${m.title ?? s.librivox}, ${file.title ?? s.file}`,
    page: `https://archive.org/details/${s.librivox}`,
    author: `${creator} (text); read by LibriVox volunteers`,
    ...lic,
  }
}

export interface AvResult {
  manifest: CorpusMedia[]
  failures: string[]
}

/** Fetch every clip of `<corpus>/av-sources.yaml` not yet in `<corpus>/av-manifest.json`, and verify the rest. */
export async function fetchAv(corpus: string): Promise<AvResult> {
  const sourcesPath = join(corpus, 'av-sources.yaml')
  const manifestPath = join(corpus, 'av-manifest.json')
  if (!existsSync(sourcesPath)) return { manifest: [], failures: [] }
  const sources = Bun.YAML.parse(readFileSync(sourcesPath, 'utf8')) as MediaSource[]
  const ids = new Set<string>()
  for (const s of sources) {
    if (!/^[a-z0-9-]+$/.test(s.id)) throw new Error(`bad id ${s.id}`)
    if (ids.has(s.id)) throw new Error(`duplicate id ${s.id}`)
    ids.add(s.id)
  }
  const manifest: CorpusMedia[] = existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as CorpusMedia[]) : []
  const known = new Map(manifest.map((m) => [m.id, m]))
  mkdirSync(join(corpus, 'audio'), { recursive: true })
  mkdirSync(join(corpus, 'video'), { recursive: true })

  const failures: string[] = []
  for (const s of sources) {
    const have = known.get(s.id)
    if (!(s.kind in LENGTH)) {
      failures.push(`${s.id}: unknown kind ${s.kind}`)
      continue
    }
    const [min, max] = LENGTH[s.kind]
    const start = s.start ?? 0
    if (have) {
      // Display metadata may change; the clip may not.
      have.category = s.category
      if (s.summary) have.summary = s.summary
      else delete have.summary
      if (s.transcript) have.transcript = s.transcript
      else delete have.transcript
      const path = join(corpus, have.file)
      const sameSource = 'title' in s ? have.title === s.title : have.title.startsWith(`LibriVox ${s.librivox}/${s.file}:`)
      if (!sameSource || have.start !== start) failures.push(`${s.id}: source or start changed; give the new clip a new id`)
      else if (!existsSync(path)) failures.push(`${s.id}: in the manifest but corpus/${have.file} is missing`)
      else if (sha(path) !== have.sha256) failures.push(`${s.id}: clip bytes changed`)
      continue
    }
    const src = await ('title' in s ? commons(s) : librivox(s))
    if (typeof src === 'string') {
      failures.push(`${s.id}: ${src}`)
      continue
    }
    let duration = s.duration ?? DEFAULT_LENGTH[s.kind]
    if (src.length !== null) duration = Math.min(duration, Math.floor((src.length - start) * 10) / 10)
    if (duration < min || duration > max) {
      failures.push(`${s.id}: ${duration}s is outside the ${min}-${max}s a ${s.kind} clip may be`)
      continue
    }
    const file = s.kind === 'video' ? `video/${s.id}.${VIDEO_EXT}` : `audio/${s.id}.${AUDIO_EXT}`
    const out = join(corpus, file)
    try {
      // Fast seek first; if the output is missing or short (some Ogg files cannot be seeked), decode from the start.
      for (const slow of [false, true]) {
        for (let attempt = 0; ; attempt++) {
          await Bun.sleep(2500)
          try {
            if (s.kind === 'video') toVideo(src.url, out, start, duration, slow)
            else toAudio(src.url, out, start, duration, KBPS[s.kind], slow)
            break
          } catch (err) {
            if (attempt >= 2) throw err
            await Bun.sleep(30_000) // rate limited, most likely
          }
        }
        if (Bun.file(out).size > 1000 && probe(out).duration >= duration - 1) break
      }
      const p = probe(out)
      if (s.kind === 'video' && (p.audio || p.height !== 360)) throw new Error(`stored video has audio or height ${p.height}`)
      if (s.kind !== 'video' && (p.width || p.duration < min - 0.5)) throw new Error(`stored audio is ${p.duration}s`)
      manifest.push({
        id: s.id,
        kind: s.kind,
        category: s.category,
        file,
        title: src.title,
        page: src.page,
        author: src.author,
        licence: src.licence,
        licence_url: src.licence_url,
        start,
        duration: Math.round(p.duration * 10) / 10,
        bytes: Bun.file(out).size,
        sha256: sha(out),
        ...(p.width && p.height ? { width: p.width, height: p.height } : {}),
        ...(s.summary ? { summary: s.summary } : {}),
        ...(s.transcript ? { transcript: s.transcript } : {}),
      })
      console.log(`${s.id}: ${s.kind}, ${src.licence}, ${p.duration.toFixed(1)}s, ${(Bun.file(out).size / 1024).toFixed(0)} KB`)
    } catch (err) {
      failures.push(`${s.id}: ${String(err).split('\n')[0]}`)
    }
  }
  const order = new Map(sources.map((s, i) => [s.id, i]))
  manifest.sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9))
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return { manifest, failures }
}

/** The attribution table rows for ATTRIBUTIONS.md. */
export function avAttributionLines(manifest: CorpusMedia[]): string[] {
  if (manifest.length === 0) return []
  const cell = (s: string) => s.replace(/\|/g, '\\|')
  const credit = (s: string) => cell(s).replace(/\b(?:https?:\/\/|www\.)\S+/g, (u) => `\`${u}\``)
  return [
    '## Audio and video',
    '',
    'Sound, speech and video clips are trimmed, converted renditions (16 kHz mono Opus; 360p H.264 without sound) of the Wikimedia Commons files and LibriVox recordings (public domain) linked below.',
    '',
    '| Clip | Kind | Source | Author | Licence |',
    '| --- | --- | --- | --- | --- |',
    ...manifest.map((m) => {
      const lic = m.licence_url ? `[${m.licence}](${m.licence_url})` : m.licence
      return `| \`${m.id}\` | ${m.kind} | [${cell(m.title.replace(/^File:/, ''))}](${m.page}) | ${credit(m.author)} | ${lic} |`
    }),
    '',
  ]
}
