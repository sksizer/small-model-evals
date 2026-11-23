// Picks the speech-to-text clips (docs/plans/transcribe.md) and appends their entries to
// corpus/av-sources.yaml. The picks are deterministic: a hash of the speaker or meeting orders the
// candidates, so a rerun chooses the same clips and an entry already listed is left alone.
//
//   bun scripts/pick-asr.ts librispeech   read, read-hard and long from LibriSpeech, and the noisy mixes made from some read clips
//   bun scripts/pick-asr.ts ami           conversation windows from the AMI meetings
//   bun scripts/fetch-corpus.ts           make the clips (ffmpeg) and list them in corpus/av-manifest.json
//
// `ami` fetches the annotations and the four meetings' headset mixes into .cache/ami/ (one licence-page check).
// `librispeech` needs the two archives unpacked under .cache/librispeech/ (scripts/fetch-av.ts does that
// on the first fetch; run this after one fetch, or unpack them by hand).
import { appendFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './ledger.ts'
import { probe } from './ffmpeg.ts'
import { amiWordsDir, ensureAmi, lsDir, lsTranscript, lsUtteranceFile, type LsSet } from './asr-sources.ts'

const SOURCES = join(ROOT, 'corpus', 'av-sources.yaml')

const hash = (s: string): number => {
  let h = 2166136261
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0
  return h
}
const listed = () => readFileSync(SOURCES, 'utf8')
const dirs = (path: string) => readdirSync(path).filter((n) => /^\d+$/.test(n)).sort((a, b) => Number(a) - Number(b))

/** Reader id to 'F' or 'M', from the SPEAKERS.TXT that ships in the archive. */
function genders(): Map<string, string> {
  const text = readFileSync(join(lsDir('test-clean'), 'LibriSpeech', 'SPEAKERS.TXT'), 'utf8')
  const out = new Map<string, string>()
  for (const line of text.split('\n')) {
    const f = line.split('|').map((x) => x.trim())
    if (!line.startsWith(';') && f.length >= 3) out.set(f[0]!, f[1]!)
  }
  return out
}

interface Utterance { id: string; seconds: number; text: string }

/** Every utterance of one chapter, in order. */
function chapter(set: LsSet, speaker: string, chap: string): Utterance[] {
  return [...lsTranscript(set, speaker, chap)].map(([id, text]) => ({ id, text, seconds: probe(lsUtteranceFile(set, id)).duration }))
}

/** `n` speakers of `set` with `women` of them female, in hash order under `salt`. */
function speakers(set: LsSet, n: number, women: number, salt: string): string[] {
  const sex = genders()
  const all = dirs(join(lsDir(set), 'LibriSpeech', set)).sort((a, b) => hash(salt + a) - hash(salt + b))
  return [...all.filter((s) => sex.get(s) === 'F').slice(0, women), ...all.filter((s) => sex.get(s) === 'M').slice(0, n - women)]
}

/** The AMI meetings the conversation clips come from (four-person scenario meetings), and how many windows each gives. */
const MEETINGS = [{ id: 'ES2004a', n: 3 }, { id: 'IS1009a', n: 3 }, { id: 'TS3003a', n: 2 }, { id: 'ES2010a', n: 2 }]

interface Word { start: number; end: number; speaker: string; text: string; spoken: boolean }

/** Every word and vocal sound of a meeting, from the manual transcripts; `spoken` is false for a truncated fragment, which no reference should demand. */
function meetingWords(meeting: string): { words: Word[]; gaps: [number, number][] } {
  const words: Word[] = []
  const gaps: [number, number][] = []
  for (const name of readdirSync(amiWordsDir).filter((n) => n.startsWith(`${meeting}.`))) {
    const speaker = name.split('.')[1]!
    for (const line of readFileSync(join(amiWordsDir, name), 'latin1').split('\n')) {
      const t = /starttime="([\d.]+)" endtime="([\d.]+)"/.exec(line)
      if (!t) continue
      const [start, end] = [Number(t[1]), Number(t[2])]
      if (line.includes('<gap')) gaps.push([start, end])
      else if (line.includes('<vocalsound')) words.push({ start, end, speaker, text: '', spoken: false })
      else if (line.includes('<w ') && !line.includes('punc="true"')) {
        const text = /<w [^>]*>([^<]*)<\/w>/.exec(line)?.[1]?.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c))).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim().toLowerCase() ?? ''
        words.push({ start, end, speaker, text, spoken: !line.includes('trunc="true"') && text !== '' })
      }
    }
  }
  return { words: words.sort((a, b) => a.start - b.start || a.end - b.end), gaps }
}

/**
 * Windows of 20 to 30 s of one meeting, each cut in a silence where no speaker is mid-word, with three or more
 * speakers, no untranscribed gap and at least 40 words, the most overlapping speech first and no two within 2 minutes.
 */
function windows(meeting: string, n: number): { start: number; duration: number; reference: string }[] {
  const { words, gaps } = meetingWords(meeting)
  // Cut points: the middle of every stretch of 0.2 s or more in which nobody speaks.
  const cuts: number[] = []
  let reach = 0
  for (const w of words) {
    if (w.start - reach >= 0.2) cuts.push((w.start + reach) / 2)
    reach = Math.max(reach, w.end)
  }
  const scored: { start: number; end: number; score: number }[] = []
  for (const [i, from] of cuts.entries()) {
    const to = cuts.slice(i + 1).filter((c) => c - from >= 20 && c - from <= 30).sort((a, b) => Math.abs(a - from - 25) - Math.abs(b - from - 25))[0]
    if (to === undefined || gaps.some(([a, b]) => a < to && b > from)) continue
    const inside = words.filter((w) => w.start >= from && w.end <= to)
    const spoken = inside.filter((w) => w.spoken)
    const speakers = new Set(spoken.map((w) => w.speaker))
    if (speakers.size < 3 || spoken.length < 40) continue
    // Seconds in which a second speaker starts before the first has finished.
    let overlap = 0
    let busy = 0
    for (const w of inside) {
      overlap += Math.max(0, Math.min(busy, w.end) - w.start)
      busy = Math.max(busy, w.end)
    }
    scored.push({ start: from, end: to, score: overlap + speakers.size * 5 })
  }
  const chosen: typeof scored = []
  for (const c of scored.sort((a, b) => b.score - a.score || a.start - b.start)) {
    if (chosen.length < n && chosen.every((o) => Math.abs(o.start - c.start) >= 120)) chosen.push(c)
  }
  return chosen
    .sort((a, b) => a.start - b.start)
    .map((c) => {
      const start = Math.round(c.start * 100) / 100
      const duration = Math.round((c.end - c.start) * 100) / 100
      const said = words.filter((w) => w.spoken && w.start >= c.start && w.end <= c.end)
      return { start, duration, reference: said.map((w) => w.text).join(' ') }
    })
}

const entry = (id: string, asrKind: string, set: LsSet, utterances: string[], reference: string) =>
  JSON.stringify({ id, kind: 'transcribe', asr_kind: asrKind, category: asrKind, librispeech: set, utterances, reference })

const lines: string[] = []
const add = (line: string, id: string) => {
  if (!listed().includes(`"id":"${id}"`)) lines.push(line)
}

/** One utterance of 6 to 25 s per speaker, picked by hash from a hash-picked chapter. */
function singles(set: LsSet, asrKind: string, n: number, women: number): string[] {
  const ids: string[] = []
  for (const speaker of speakers(set, n, women, `${asrKind}-`)) {
    const chaps = dirs(join(lsDir(set), 'LibriSpeech', set, speaker)).sort((a, b) => hash(speaker + a) - hash(speaker + b))
    const fit = chapter(set, speaker, chaps[0]!).filter((u) => u.seconds >= 6 && u.seconds <= 25)
    const u = fit[hash(`${asrKind}-${speaker}`) % fit.length]!
    const id = `asr-ls-${u.id}`
    add(entry(id, asrKind, set, [u.id], u.text.toLowerCase()), id)
    ids.push(id)
  }
  return ids
}

if (process.argv[2] === 'librispeech') {
  const read = singles('test-clean', 'read', 25, 13)
  singles('test-other', 'read-hard', 15, 8)

  // Long: consecutive utterances of one chapter, 60 to 120 s (aiming for about 75 s), 3 women and 3 men.
  const sex = genders()
  const readers = speakers('test-clean', 12, 6, 'long-')
  let women = 0
  let men = 0
  for (const speaker of readers) {
    const f = sex.get(speaker) === 'F'
    if (f ? women >= 3 : men >= 3) continue
    const chaps = dirs(join(lsDir('test-clean'), 'LibriSpeech', 'test-clean', speaker)).sort((a, b) => hash(speaker + a) - hash(speaker + b))
    for (const chap of chaps) {
      const all = chapter('test-clean', speaker, chap)
      const first = hash(`long-${speaker}-${chap}`) % Math.max(1, all.length - 8)
      const run: Utterance[] = []
      let seconds = 0
      for (const u of all.slice(first)) {
        if (seconds + u.seconds > 118) break
        run.push(u)
        seconds += u.seconds
        if (seconds >= 70) break
      }
      if (seconds < 60) continue
      const id = `asr-long-${run[0]!.id}`
      add(entry(id, 'long', 'test-clean', run.map((u) => u.id), run.map((u) => u.text.toLowerCase()).join(' ')), id)
      if (f) women++
      else men++
      break
    }
  }

  // Noisy: five read clips of 10 to 22 s, each mixed with two corpus sounds, at 10 dB and at 0 dB (scripts/av-recipes.ts).
  const noise = [['snd-rain-2', 'rain'], ['snd-motorbike-1', 'traffic'], ['snd-applause-1', 'crowd'], ['snd-wind-1', 'wind'], ['snd-cooking-1', 'kitchen']] as const
  const parents = read.filter((id) => {
    const s = probe(lsUtteranceFile('test-clean', id.replace('asr-ls-', ''))).duration
    return s >= 10 && s <= 22
  })
  parents.slice(0, 5).forEach((parent, i) => {
    for (const [j, snr] of [[i, 10], [(i + 1) % noise.length, 0]] as const) {
      const [sound, name] = noise[j]!
      const id = `asr-noisy-${parent.replace('asr-ls-', 'ls-')}-${name}-snr${snr}`
      add(JSON.stringify({ id, kind: 'transcribe', asr_kind: 'noisy', category: 'noisy', derived: parent, recipe: `snr${snr}`, noise: sound }), id)
    }
  })
} else if (process.argv[2] === 'ami') {
  for (const meeting of MEETINGS) {
    const why = await ensureAmi(meeting.id)
    if (why) throw new Error(why)
    for (const w of windows(meeting.id, meeting.n)) {
      const id = `asr-ami-${meeting.id.toLowerCase()}-${String(Math.round(w.start)).padStart(4, '0')}`
      add(JSON.stringify({ id, kind: 'transcribe', asr_kind: 'conversation', category: 'conversation', ami: meeting.id, start: w.start, duration: w.duration, reference: w.reference }), id)
    }
  }
} else {
  console.error('usage: bun scripts/pick-asr.ts librispeech | ami')
  process.exit(2)
}

if (lines.length > 0) appendFileSync(SOURCES, `${lines.map((l) => `- ${l}`).join('\n')}\n`)
console.log(`${lines.length} entries appended; run scripts/fetch-corpus.ts`)
