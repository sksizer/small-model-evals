// Writes the regions-text cases: the text lines on each synthetic page in
// corpus/sources.yaml, boxed exactly. Each page is laid out by the same
// headless Chrome, at the same window size, that rendered its corpus PNG
// (scripts/fetch-corpus.ts); a script injected into a temporary copy of the
// page measures every text line and Chrome's --dump-dom hands the result back.
//
//   bun scripts/text-boxes.ts
//
// A line is the run of text on one visual line within one box of text: words
// split by inline tags (`<b>TOTAL</b>`) join up when they sit close together,
// and text far apart on the same row (two table cells) stays two lines, as an
// OCR detector would see it. Existing case files are left alone (cases are
// immutable).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnRunner } from '@osdlc/command-seam'
import { chrome } from './chrome.ts'
import { ROOT } from './ledger.ts'

const CORPUS = join(ROOT, 'corpus')
const CASES = join(ROOT, 'suites', 'regions-text', 'cases')

// Runs in the page: every text node's line fragments, merged per line.
const MEASURE = `
<script>
(() => {
  const frags = []
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (!n.textContent.trim()) continue
    const r = document.createRange()
    r.selectNodeContents(n)
    for (const q of r.getClientRects()) if (q.width > 1 && q.height > 1) frags.push([q.left, q.top, q.right, q.bottom])
  }
  frags.sort((a, b) => a[1] - b[1] || a[0] - b[0])
  const lines = []
  for (const f of frags) {
    const h = f[3] - f[1]
    const l = lines.find((x) => Math.abs(x[1] - f[1]) < h * 0.3 && Math.abs(x[3] - f[3]) < h * 0.3 && f[0] - x[2] < h * 0.6 && f[0] >= x[0])
    if (l) { l[2] = Math.max(l[2], f[2]); l[1] = Math.min(l[1], f[1]); l[3] = Math.max(l[3], f[3]) }
    else lines.push([...f])
  }
  const out = document.createElement('pre')
  out.id = '__boxes'
  out.textContent = JSON.stringify(lines)
  document.body.append(out)
})()
</script>`

interface Synthetic {
  id: string
  synthetic: string
  size: [number, number]
}

const sources = Bun.YAML.parse(readFileSync(join(CORPUS, 'sources.yaml'), 'utf8')) as (Synthetic | { synthetic?: undefined })[]
mkdirSync(CASES, { recursive: true })
for (const s of sources.filter((x): x is Synthetic => typeof x.synthetic === 'string')) {
  const casePath = join(CASES, `${s.id}-text.yaml`)
  if (existsSync(casePath)) {
    console.log(`${s.id}: case exists, kept`)
    continue
  }
  const page = join(CORPUS, s.synthetic)
  // Beside the original so relative links (_base.css) resolve.
  const tmp = join(CORPUS, 'synthetic', `.measure-${s.id}.html`)
  writeFileSync(tmp, readFileSync(page, 'utf8').replace('</body>', `${MEASURE}</body>`))
  try {
    const res = spawnRunner(chrome()).run(
      ['--headless', '--hide-scrollbars', '--force-device-scale-factor=1', `--window-size=${s.size[0]},${s.size[1]}`, '--dump-dom', `file://${tmp}`],
      { cwd: ROOT },
    )
    const m = /<pre id="__boxes">([^<]*)<\/pre>/.exec(res.stdout)
    if (!m) throw new Error(`${s.id}: no measurements in Chrome's output: ${res.stderr.slice(0, 300)}`)
    const [w, h] = s.size
    const r4 = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 10000) / 10000
    const lines = (JSON.parse(m[1]!) as number[][])
      .filter((b) => b[0]! < w && b[1]! < h && b[2]! > 0 && b[3]! > 0)
      .map((b) => [b[0]! / w, b[1]! / h, b[2]! / w, b[3]! / h].map(r4))
    const yaml = [
      `description: "text lines: ${s.id} (synthetic page, ${lines.length} lines)"`,
      `metadata: { id: ${s.id}-text }`,
      'vars:',
      `  image: file://../../corpus/images/${s.id}.png`,
      '  find: [text]',
      '  expected:',
      '    boxes:',
      ...lines.map((b) => `      - { label: text, box: [${b.join(', ')}] }`),
    ]
    writeFileSync(casePath, `${yaml.join('\n')}\n`)
    console.log(`${s.id}: ${lines.length} lines`)
  } finally {
    rmSync(tmp, { force: true })
  }
}
