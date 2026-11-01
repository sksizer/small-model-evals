// Open Images (validation set) helpers shared by scripts/fetch-corpus.ts and
// scripts/pick-openimages.ts: the dataset's index files, downloaded once into
// .cache/openimages/ (gitignored), and a CSV line splitter. Some of the
// files use CRLF line endings, so lines split on /\r?\n/.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './ledger.ts'

export const OI_IMAGES = 'https://storage.googleapis.com/openimages/2018_04/validation/validation-images-with-rotation.csv'
export const OI_LICENCE = 'https://creativecommons.org/licenses/by/2.0/'
export const OI_CACHE = join(ROOT, '.cache', 'openimages')

/** A downloaded Open Images index file, fetched once into .cache/openimages/. */
export async function oiFile(url: string): Promise<string> {
  const path = join(OI_CACHE, url.split('/').pop()!)
  if (!existsSync(path)) {
    mkdirSync(OI_CACHE, { recursive: true })
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
    writeFileSync(path, new Uint8Array(await res.arrayBuffer()))
  }
  return path
}

/** Splits one CSV line, honouring quoted fields. */
export function csvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (ch === '"') quoted = false
      else cur += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

let oiRows: Map<string, Record<string, string>> | null = null
export async function oiImage(id: string): Promise<Record<string, string> | undefined> {
  if (!oiRows) {
    const [head, ...lines] = await oiLines(OI_IMAGES)
    const cols = csvLine(head!)
    oiRows = new Map(
      lines.map((l) => {
        const v = csvLine(l)
        return [v[0]!, Object.fromEntries(cols.map((c, i) => [c, v[i] ?? '']))]
      }),
    )
  }
  return oiRows.get(id)
}

/** A downloaded index file's lines, CRLF or LF. */
export async function oiLines(url: string): Promise<string[]> {
  return readFileSync(await oiFile(url), 'utf8').split(/\r?\n/).filter(Boolean)
}
