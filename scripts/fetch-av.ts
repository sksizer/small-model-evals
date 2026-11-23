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
// - a LibriSpeech clip (`librispeech: test-clean | test-other`, `utterances: [<id>, ...]`), kind `transcribe`.
//   The utterances (one, or consecutive ones of a chapter for a `long` clip) are joined into one clip. The
//   licence is read from openslr.org/12 (CC BY 4.0) before the archive is downloaded into .cache/.
// - an AMI meeting window (`ami: <meeting>`, `start`, `duration`), kind `transcribe`: the headset mix of the
//   meeting, cut at word boundaries. The licence is read from the AMI licence page (CC BY 4.0).
//   Both carry the exact `reference` transcript the clip is scored against and an `asr_kind` (`read`,
//   `read-hard`, `long`, `noisy` or `conversation`); see scripts/pick-asr.ts and docs/plans/transcribe.md.
//
// `start` and `duration` (seconds) pick the segment. `kind` is `sound`, `speech`, `transcribe`
// or `video`; each is converted with ffmpeg (scripts/ffmpeg.ts) into the stored
// format of docs/standards/corpus.md: sound, speech and transcribe as 16 kHz mono Opus in
// audio/<id>.ogg, video as 360p H.264 with no sound track in video/<id>.mp4.
// Speech also carries a `summary` (one line) and, where the book's text could be
// matched, an approximate `transcript`.
//
// - a derived copy (`derived: <id>`, `recipe: <name>`) of a stored clip, made with ffmpeg by one of the
//   recipes of scripts/av-recipes.ts (trimmed, recompressed, quieter; a video re-encoded or cut). It
//   keeps its parent's page, author and licence, and names the parent in the manifest (`derived_from`,
//   `recipe`). The parent is listed above it, so it is already in the manifest. A `noisy` transcribe clip is
//   a derived copy of a `read` clip with a sound mixed under it (`recipe: snr10 | snr0`, `noise: <sound id>`,
//   scripts/av-recipes.ts): it keeps the parent's reference, and credits the sound as well (`mixed_with`).
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
import {
  AMI_AUTHOR, AMI_PAGE, LS_AUTHOR, LS_LICENCE_URL, LS_PAGE, amiWav, ensureAmi, ensureLibrispeech, lsUtteranceFile, type LsSet,
} from './asr-sources.ts'
import { AUDIO_RECIPES, NOISE_RECIPES, VIDEO_RECIPES, type AvRecipe } from './av-recipes.ts'
import { AUDIO_EXT, VIDEO_EXT, joinAudio, mixAudio, probe, reencodeAudio, reencodeVideo, toAudio, toVideo } from './ffmpeg.ts'
import { ALLOWED } from './licences.ts'

export type MediaKind = 'sound' | 'speech' | 'transcribe' | 'video'

/** What a `transcribe` clip is: the `metadata.kind` of its cases. */
export type AsrKind = 'read' | 'read-hard' | 'long' | 'noisy' | 'conversation'

type MediaSource = {
  id: string
  kind: MediaKind
  category: string
  start?: number
  duration?: number
  summary?: string
  transcript?: string
  asr_kind?: AsrKind
  reference?: string
} & (
  | { title: string }
  | { librivox: string; file: string }
  | { librispeech: LsSet; utterances: string[] }
  | { ami: string }
  | { derived: string; recipe: AvRecipe; noise?: string }
)

/** One stored clip: corpus/av-manifest.json. */
export interface CorpusMedia {
  id: string
  kind: MediaKind
  category: string
  /** Path under corpus/. */
  file: string
  /** `File:...` on Commons, `LibriVox <item>/<file>: <book>, <chapter>`, `LibriSpeech <set> <utterance>...`, `AMI <meeting> ...`, or for a derived copy `<recipe> of <parent>`. */
  title: string
  page: string
  author: string
  licence: string
  licence_url: string | null
  /** Where in the source (for a derived copy, in its parent) the clip starts, and its length in the stored file, in seconds. */
  start: number
  duration: number
  bytes: number
  sha256: string
  width?: number
  height?: number
  summary?: string
  /** Speech only: the book text this clip reads, approximate (see av-sources.yaml). */
  transcript?: string
  /** For a derived copy: the clip it was made from, and how (scripts/av-recipes.ts). */
  derived_from?: string
  recipe?: AvRecipe
  /** `transcribe` only: what the clip is, and the exact words said in it, which its cases score against. */
  asr_kind?: AsrKind
  reference?: string
  /** A `noisy` clip: the sound mixed under it, credited as well as `derived_from`. */
  mixed_with?: string
}

/** Allowed stored length in seconds, per kind (docs/standards/corpus.md). */
export const LENGTH: Record<MediaKind, [number, number]> = { sound: [5, 30], speech: [60, 120], transcribe: [5, 120], video: [5, 15] }
const DEFAULT_LENGTH: Record<MediaKind, number> = { sound: 20, speech: 90, transcribe: 20, video: 10 }
// Speech meant for transcription is stored at the sound rate: heavier compression would add errors the models are scored for.
const KBPS = { sound: 24, speech: 16, transcribe: 24 }

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

type AsrSource = MediaSource & ({ librispeech: LsSet; utterances: string[] } | { ami: string })

/** The manifest title of a LibriSpeech clip: `LibriSpeech <set> <first utterance>`, and `to <last>` for a joined run. */
const asrTitle = (s: MediaSource & { librispeech: LsSet; utterances: string[] }): string =>
  `LibriSpeech ${s.librispeech} ${s.utterances[0]}${s.utterances.length > 1 ? ` to ${s.utterances.at(-1)}` : ''}`

/** Make one LibriSpeech or AMI clip into corpus/audio/ and describe it, or say why it cannot be. */
async function asrClip(corpus: string, s: AsrSource, min: number, max: number): Promise<CorpusMedia | string> {
  if (s.kind !== 'transcribe' || !s.asr_kind || !s.reference) return 'a transcribe clip needs kind transcribe, asr_kind and reference'
  const file = `audio/${s.id}.${AUDIO_EXT}`
  const out = join(corpus, file)
  try {
    let start = 0
    let describe: Pick<CorpusMedia, 'title' | 'page' | 'author' | 'licence' | 'licence_url'>
    if ('librispeech' in s) {
      const why = await ensureLibrispeech(s.librispeech)
      if (why) return why
      joinAudio(s.utterances.map((u) => lsUtteranceFile(s.librispeech, u)), out, KBPS.transcribe)
      describe = { title: asrTitle(s), page: LS_PAGE, author: LS_AUTHOR, licence: 'CC BY 4.0', licence_url: LS_LICENCE_URL }
    } else {
      if (s.start === undefined || s.duration === undefined) return 'an AMI clip needs start and duration'
      const why = await ensureAmi(s.ami)
      if (why) return why
      start = s.start
      toAudio(amiWav(s.ami), out, start, s.duration, KBPS.transcribe)
      describe = {
        title: `AMI ${s.ami} Mix-Headset, ${start}-${Math.round((start + s.duration) * 100) / 100} s`,
        page: AMI_PAGE,
        author: AMI_AUTHOR,
        licence: 'CC BY 4.0',
        licence_url: LS_LICENCE_URL,
      }
          }
    const p = probe(out)
    if (p.width || p.duration < min - 0.5 || p.duration > max + 0.5) throw new Error(`stored audio is ${p.duration}s, outside the ${min}-${max}s a ${s.kind} clip may be`)
    return {
      id: s.id,
      kind: s.kind,
      category: s.category,
      file,
      ...describe,
      start,
      duration: Math.round(p.duration * 10) / 10,
      bytes: Bun.file(out).size,
      sha256: sha(out),
      asr_kind: s.asr_kind,
      reference: s.reference,
    }
  } catch (err) {
    return String(err).split('\n')[0]!
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
      if (!('derived' in s) && have.reference !== s.reference) failures.push(`${s.id}: reference changed; give the new clip a new id`)
      const sameSource =
        'title' in s
          ? have.title === s.title
          : 'derived' in s
            ? have.title === `${s.recipe} of ${s.derived}`
            : 'librispeech' in s
              ? have.title === asrTitle(s)
              : 'ami' in s
                ? have.title.startsWith(`AMI ${s.ami} `)
                : have.title.startsWith(`LibriVox ${s.librivox}/${s.file}:`)
      if (!sameSource || ('derived' in s ? false : have.start !== start)) failures.push(`${s.id}: source or start changed; give the new clip a new id`)
      else if (!existsSync(path)) failures.push(`${s.id}: in the manifest but corpus/${have.file} is missing`)
      else if (sha(path) !== have.sha256) failures.push(`${s.id}: clip bytes changed`)
      continue
    }
    if ('derived' in s) {
      const parent = manifest.find((m) => m.id === s.derived)
      if (!parent) {
        failures.push(`${s.id}: parent ${s.derived} is not in the manifest (list it above this entry and rerun)`)
        continue
      }
      const file = s.kind === 'video' ? `video/${s.id}.${VIDEO_EXT}` : `audio/${s.id}.${AUDIO_EXT}`
      const out = join(corpus, file)
      const noise = s.noise ? manifest.find((m) => m.id === s.noise) : undefined
      try {
        const from = join(corpus, parent.file)
        let at: number
        if (s.kind === 'video') {
          const r = VIDEO_RECIPES[s.recipe as keyof typeof VIDEO_RECIPES]
          if (!r) throw new Error(`unknown video recipe ${s.recipe}`)
          at = r.start
          reencodeVideo(from, out, at, r.length ?? parent.duration, r.crf)
        } else if (s.recipe in NOISE_RECIPES) {
          if (!noise) throw new Error(`${s.recipe} needs \`noise\`, the id of a sound in the manifest above it`)
          at = 0
          mixAudio(from, join(corpus, noise.file), out, NOISE_RECIPES[s.recipe as keyof typeof NOISE_RECIPES].snrDb, KBPS.transcribe)
        } else {
          const r = AUDIO_RECIPES[s.recipe as keyof typeof AUDIO_RECIPES]
          if (!r) throw new Error(`unknown audio recipe ${s.recipe}`)
          at = r.start(parent.duration)
          reencodeAudio(from, out, at, r.length(parent.duration), r.kbps, r.gainDb)
        }
        const p = probe(out)
        if (p.duration < min - 0.5 || p.duration > max + 0.5) throw new Error(`${p.duration}s is outside the ${min}-${max}s a ${s.kind} clip may be`)
        manifest.push({
          id: s.id,
          kind: s.kind,
          category: s.category,
          file,
          title: `${s.recipe} of ${s.derived}`,
          page: parent.page,
          author: noise ? `${parent.author}; ${noise.author}` : parent.author,
          licence: parent.licence,
          licence_url: parent.licence_url,
          start: at,
          duration: Math.round(p.duration * 10) / 10,
          bytes: Bun.file(out).size,
          sha256: sha(out),
          ...(p.width && p.height ? { width: p.width, height: p.height } : {}),
          derived_from: s.derived,
          recipe: s.recipe,
          ...(s.asr_kind ? { asr_kind: s.asr_kind } : {}),
          ...(parent.reference ? { reference: parent.reference } : {}),
          ...(noise ? { mixed_with: noise.id } : {}),
        })
        console.log(`${s.id}: ${s.recipe} of ${s.derived}, ${p.duration.toFixed(1)}s, ${(Bun.file(out).size / 1024).toFixed(0)} KB`)
      } catch (err) {
        failures.push(`${s.id}: ${String(err).split('\n')[0]}`)
      }
      continue
    }
    if ('librispeech' in s || 'ami' in s) {
      const clip = await asrClip(corpus, s, min, max)
      if (typeof clip === 'string') failures.push(`${s.id}: ${clip}`)
      else {
        manifest.push(clip)
        console.log(`${s.id}: ${s.asr_kind}, ${clip.licence}, ${clip.duration.toFixed(1)}s, ${(clip.bytes / 1024).toFixed(0)} KB`)
      }
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
    'Sound, speech and video clips are trimmed, converted renditions (16 kHz mono Opus; 360p H.264 without sound) of the Wikimedia Commons files and LibriVox recordings (public domain) linked below; the `transcribe` clips are cut from LibriSpeech and the AMI Meeting Corpus (both CC BY 4.0) and may be mixed with a sound of the corpus. Derived copies (trimmed, recompressed, quieter, re-encoded, cut, mixed) keep their parent\'s credit.',
    '',
    '| Clip | Kind | Source | Author | Licence |',
    '| --- | --- | --- | --- | --- |',
    ...manifest.map((m) => {
      const lic = m.licence_url ? `[${m.licence}](${m.licence_url})` : m.licence
      const mixed = m.mixed_with ? `, mixed with \`${m.mixed_with}\`` : ''
      return `| \`${m.id}\` | ${m.kind} | [${cell(m.title.replace(/^File:/, ''))}](${m.page})${mixed} | ${credit(m.author)} | ${lic} |`
    }),
    '',
  ]
}
