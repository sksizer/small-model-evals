// Where the speech-to-text clips come from (docs/plans/transcribe.md): LibriSpeech (openslr.org/12) and the
// AMI Meeting Corpus. Both are large archives, kept under .cache/ (gitignored) and never committed; the clips
// cut from them are what scripts/fetch-av.ts stores. Each licence is read off the source's own page before
// anything is downloaded.
import { spawnRunner } from '@osdlc/command-seam'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { UA, stripHtml } from './commons.ts'
import { ROOT } from './ledger.ts'

const CACHE = join(ROOT, '.cache')

/** Fetch a page and check that its text says `says`; the licence is read at the source, not assumed. */
async function pageSays(url: string, says: RegExp): Promise<string | null> {
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) return `${url}: HTTP ${res.status}`
  return says.test(stripHtml(await res.text()).replace(/\s+/g, ' ')) ? null : `${url} no longer says the licence we expect (${says})`
}

/** Download `url` to `path` unless it is there, retrying a service that is down for a moment. */
async function fetchTo(url: string, path: string): Promise<string | null> {
  if (existsSync(path)) return null
  mkdirSync(join(path, '..'), { recursive: true })
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } })
    if (res.ok) {
      await Bun.write(`${path}.part`, res)
      renameSync(`${path}.part`, path)
      return null
    }
    if (attempt === 3) return `${url}: HTTP ${res.status}`
    await Bun.sleep(30_000)
  }
  return null
}

// --- LibriSpeech -------------------------------------------------------------------------------------------

export const LS_SETS = ['test-clean', 'test-other'] as const
export type LsSet = (typeof LS_SETS)[number]

export const LS_PAGE = 'https://www.openslr.org/12/'
export const LS_LICENCE_URL = 'https://creativecommons.org/licenses/by/4.0/'
export const LS_AUTHOR = 'Vassil Panayotov, Guoguo Chen, Daniel Povey and Sanjeev Khudanpur (LibriSpeech); recordings and text from LibriVox volunteers and Project Gutenberg'

/** The unpacked archive of one subset: <dir>/LibriSpeech/<set>/<reader>/<chapter>/. */
export const lsDir = (set: LsSet): string => join(CACHE, 'librispeech', set)

/** The FLAC file of utterance `<reader>-<chapter>-<n>`. */
export const lsUtteranceFile = (set: LsSet, utterance: string): string => {
  const [reader, chap] = utterance.split('-')
  return join(lsDir(set), 'LibriSpeech', set, reader!, chap!, `${utterance}.flac`)
}

/** utterance id to its transcript (upper case, as LibriSpeech ships it) for one chapter. */
export function lsTranscript(set: LsSet, reader: string, chap: string): Map<string, string> {
  const text = readFileSync(join(lsDir(set), 'LibriSpeech', set, reader, chap, `${reader}-${chap}.trans.txt`), 'utf8')
  return new Map(text.split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf(' ')), l.slice(l.indexOf(' ') + 1)]))
}

/** Check the licence at openslr.org/12 and unpack `set` into .cache/ unless it already is. Returns why not, or null. */
export async function ensureLibrispeech(set: LsSet): Promise<string | null> {
  if (existsSync(join(lsDir(set), 'LibriSpeech', set))) return null
  const bad = await pageSays(LS_PAGE, /License:\s*CC BY 4\.0/i)
  if (bad) return bad
  // openslr.elda.org is one of the mirrors the page lists; openslr.org itself is far slower from some places.
  const archive = `${lsDir(set)}.tar.gz`
  const failed = await fetchTo(`https://openslr.elda.org/resources/12/${set}.tar.gz`, archive)
  if (failed) return failed
  mkdirSync(lsDir(set), { recursive: true })
  const res = spawnRunner('tar').run(['-xzf', archive, '-C', lsDir(set)], { cwd: ROOT })
  return res.exitCode === 0 ? null : `tar failed on ${archive}: ${res.stderr.trim()}`
}

// --- AMI ---------------------------------------------------------------------------------------------------

export const AMI_PAGE = 'https://groups.inf.ed.ac.uk/ami/corpus/'
export const AMI_LICENCE_PAGE = 'https://groups.inf.ed.ac.uk/ami/corpus/license.shtml'
export const AMI_AUTHOR = 'AMI Consortium (Carletta et al.), meeting participants recorded with their consent for research'

export const amiDir = join(CACHE, 'ami')

/** The headset-mix recording of one meeting. */
export const amiWav = (meeting: string): string => join(amiDir, `${meeting}.Mix-Headset.wav`)

/** The unpacked manual annotations (words/<meeting>.<speaker>.words.xml). */
export const amiWordsDir = join(amiDir, 'manual', 'words')

/** Check the licence page and download the annotations (once) and the headset mix of `meeting` into .cache/. Returns why not, or null. */
export async function ensureAmi(meeting: string): Promise<string | null> {
  if (existsSync(amiWav(meeting)) && existsSync(amiWordsDir)) return null
  const bad = await pageSays(AMI_LICENCE_PAGE, /released under the Creative Commons Attribution 4\.0 license/i)
  if (bad) return bad
  const zip = join(amiDir, 'ami_public_manual_1.6.2.zip')
  const notes = await fetchTo('https://groups.inf.ed.ac.uk/ami/AMICorpusAnnotations/ami_public_manual_1.6.2.zip', zip)
  if (notes) return notes
  if (!existsSync(amiWordsDir)) {
    const res = spawnRunner('unzip').run(['-q', '-o', zip, 'words/*', '-d', join(amiDir, 'manual')], { cwd: ROOT })
    if (res.exitCode !== 0) return `unzip failed on ${zip}: ${res.stderr.trim()}`
  }
  return fetchTo(`https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/${meeting}/audio/${meeting}.Mix-Headset.wav`, amiWav(meeting))
}
