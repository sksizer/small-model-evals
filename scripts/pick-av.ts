// Builds the audio and video part of the search suite (docs/plans/av-search.md): the derived copies,
// the corpora and one case per query. The choices are in scripts/av-search-sets.ts, with how relevance
// was judged.
//
//   bun scripts/pick-av.ts sources   add the derived copies to corpus/av-sources.yaml
//   bun scripts/fetch-corpus.ts      make the copies (ffmpeg) and list them in corpus/av-manifest.json
//   bun scripts/pick-av.ts write     write the av corpora into suites/search/corpora.yaml and cases/<kind>-<slug>.yaml
//
// `write` never overwrites a case (cases are immutable); it rewrites the av tail of corpora.yaml, which
// belongs to the suite's setup, so a changed corpus is a new suite version. scripts/pick-search.ts
// appends the same tail when it rewrites the whole file.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AV_MARKER, SOUND_QUERIES, SPEECH_QUERIES, VIDEO_QUERIES, avCorpora, avCorporaText, clipCases, copySources, type Query } from './av-search-sets.ts'
import type { CorpusMedia } from './fetch-av.ts'
import { ROOT, SUITES_DIR } from './ledger.ts'

const SUITE = join(SUITES_DIR, 'search')
const yaml = (v: unknown) => JSON.stringify(v) // JSON is YAML
const manifest = JSON.parse(readFileSync(join(ROOT, 'corpus', 'av-manifest.json'), 'utf8')) as CorpusMedia[]
const command = process.argv[2]

if (command === 'sources') {
  const path = join(ROOT, 'corpus', 'av-sources.yaml')
  const text = readFileSync(path, 'utf8')
  const fresh = copySources(manifest).filter((c) => !text.includes(`"id":"${c.id}"`))
  if (fresh.length > 0) {
    appendFileSync(
      path,
      [
        '',
        '# Derived copies (scripts/pick-av.ts; recipes in scripts/av-recipes.ts): the clip-to-clip cases of the search suite. A copy keeps its',
        "# parent's credit and licence; its id is copy-<recipe>-<parent>.",
        ...fresh.map((c) => `- ${JSON.stringify(c)}`),
        '',
      ].join('\n'),
    )
  }
  console.log(`${fresh.length} entries appended; run scripts/fetch-corpus.ts`)
} else if (command === 'write') {
  const corporaPath = join(SUITE, 'corpora.yaml')
  const old = readFileSync(corporaPath, 'utf8')
  const head = old.includes(AV_MARKER) ? old.slice(0, old.indexOf(AV_MARKER)) : `${old.trimEnd()}\n`
  writeFileSync(corporaPath, `${head}${avCorporaText(manifest)}\n`)

  const corpora = avCorpora(manifest)
  let written = 0
  const put = (id: string, lines: string[]) => {
    const path = join(SUITE, 'cases', `${id}.yaml`)
    if (existsSync(path)) return
    writeFileSync(path, `${lines.join('\n')}\n`)
    written++
  }
  const text = (kind: 'sounds' | 'speech' | 'videos', corpus: string, q: Query) => {
    const ids = new Set(corpora[corpus]!.map((i) => i.id))
    const unknown = q.relevant.filter((r) => !ids.has(r))
    if (unknown.length > 0) throw new Error(`${kind}/${q.slug}: relevant ids not in ${corpus}: ${unknown.join(', ')}`)
    const id = `${kind}-${q.hard ? 'hard-' : ''}${q.slug}`
    put(id, [
      `description: ${yaml(`search ${kind}: ${q.query} (${q.relevant.length} relevant of ${ids.size})`)}`,
      `metadata: { id: ${id}, kind: ${kind} }`,
      'vars:',
      `  kind: ${kind}`,
      `  corpus: ${corpus}`,
      `  query: ${yaml(q.query)}`,
      `  relevant: ${yaml(q.relevant)}`,
      `  how: ${yaml(q.how)}`,
    ])
  }
  for (const q of SOUND_QUERIES) text('sounds', 'sounds', q)
  for (const q of SPEECH_QUERIES) text('speech', 'speech', q)
  for (const q of VIDEO_QUERIES) text('videos', 'videos', q)
  for (const c of clipCases(manifest)) {
    const ids = new Set(corpora[c.corpus]!.map((i) => i.id))
    for (const r of [c.query, ...c.relevant]) if (!ids.has(r)) throw new Error(`${c.id}: ${r} is not in ${c.corpus}`)
    const parts = Object.entries(c.expected).filter(([, v]) => v.length > 0)
    put(c.id, [
      `description: ${yaml(`search ${c.kind}: ${c.query} (${parts.map(([k, v]) => `${v.length} ${k}`).join(', ')} of ${ids.size - 1})`)}`,
      `metadata: { id: ${c.id}, kind: ${c.kind} }`,
      'vars:',
      `  kind: ${c.kind}`,
      `  corpus: ${c.corpus}`,
      `  query_item: ${c.query}`,
      `  relevant: ${yaml(c.relevant)}`,
      `  levels: ${yaml(Object.fromEntries(parts))}`,
      `  how: ${yaml(c.how)}`,
    ])
  }
  console.log(`${written} cases written; corpora: ${Object.entries(corpora).map(([k, v]) => `${k} ${v.length}`).join(', ')}`)
} else {
  console.error('usage: bun scripts/pick-av.ts sources | write')
  process.exit(2)
}
