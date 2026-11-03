// Builds the results site, public, private or both (the default):
//
//   bun scripts/build-site.ts                 both
//   bun scripts/build-site.ts public          site/dist: what GitHub Pages serves
//   bun scripts/build-site.ts private         private/site/dist (gitignored)
//   bun scripts/build-site.ts private --serve  then serve it on localhost only
//
// The public site holds the committed suites and results. The private site
// shows everything at once: every public suite plus the suites under private/
// (your own notes and photos, the private nudity set), which are listed as
// `private-<suite>` since a suite id can exist in both scopes. It is never
// published: its data, images and build all stay under private/site/.
// SITE_BASE is passed through for the public build.
import { spawnRunner } from '@osdlc/command-seam'
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './ledger.ts'

type Scope = 'public' | 'private'
const args = process.argv.slice(2)
const serve = args.includes('--serve')
const named = args.filter((a): a is Scope => a === 'public' || a === 'private')
const scopes: Scope[] = named.length > 0 ? named : ['public', 'private']
const PRIVATE_PORT = 4400

function step(bin: string, argv: string[], cwd: string, env: Record<string, string>) {
  const r = spawnRunner(bin).run(argv, { cwd, env })
  process.stdout.write(r.stdout)
  if (r.exitCode !== 0) {
    process.stderr.write(r.stderr)
    throw new Error(`${bin} ${argv.join(' ')} failed (exit ${r.exitCode})`)
  }
}

const PUBLIC_DATA = join(ROOT, 'site', 'src', 'data', 'evals.json')
const PRIVATE_DATA = join(ROOT, 'private', 'site', 'data', 'evals.json')

/** The leaderboard export (scripts/export-site.ts), as far as merging needs it. */
interface BoardRow { model: string; cells: Record<string, { passed: number; total: number }>; avg: number; covered: number }
interface BoardFamily {
  id: string
  suites: { id: string }[]
  ranking: { suite: string }[]
  rows: BoardRow[]
  has_speed: boolean
}
interface Board { machine: { key: string }; families: BoardFamily[] }

interface Data {
  generated_at: string
  scope: string
  machines: { key: string }[]
  models: { label: string }[]
  suites: { id: string }[]
  cells: { suite: string }[]
  perf: { suite: string }[]
  inproc: { suite: string }[]
  leaderboard: Board[]
  results: { suite: string }[]
  history: { suite: string }[]
  runs: { run: string; suites: string[]; models: string[]; envs: string[]; records: number }[]
  environments: Record<string, unknown>
  builds: Record<string, unknown>
  corpus: { path: string; used_by: { suite: string }[] }[]
}

const union = <T>(key: (x: T) => string, ...lists: T[][]) => [...new Map(lists.flat().map((x) => [key(x), x])).values()]

/** Two leaderboards with the private suites (renamed) added to the public families, and each row's average recomputed. */
function mergeBoards(pub: Board[], priv: Board[], id: (suite: string) => string): Board[] {
  const rename = <T extends object>(xs: T[], key: keyof T & string) => xs.map((x) => ({ ...x, [key]: id(x[key] as string) }))
  return union((b) => b.machine.key, pub, priv).map((b) => {
    const a = pub.find((x) => x.machine.key === b.machine.key)?.families ?? []
    const p = priv.find((x) => x.machine.key === b.machine.key)?.families ?? []
    const ids = [...new Set([...a, ...p].map((f) => f.id))]
    const families = ids.map((fid) => {
      const fa = a.find((f) => f.id === fid)
      const fp = p.find((f) => f.id === fid)
      const rows = new Map((fa?.rows ?? []).map((r) => [r.model, { ...r, cells: { ...r.cells } }]))
      for (const r of fp?.rows ?? []) {
        const cells = Object.fromEntries(Object.entries(r.cells).map(([suite, c]) => [id(suite), c]))
        const into = rows.get(r.model)
        if (into) Object.assign(into.cells, cells)
        else rows.set(r.model, { ...r, cells })
      }
      const merged = [...rows.values()].map((r) => {
        const cs = Object.values(r.cells)
        return { ...r, covered: cs.length, avg: cs.reduce((sum, c) => sum + (100 * c.passed) / c.total, 0) / cs.length }
      })
      merged.sort((x, y) => y.avg - x.avg || x.model.localeCompare(y.model))
      return {
        ...(fa ?? fp!),
        suites: [...(fa?.suites ?? []), ...rename(fp?.suites ?? [], 'id')],
        ranking: [...(fa?.ranking ?? []), ...rename(fp?.ranking ?? [], 'suite')],
        rows: merged,
        has_speed: (fa?.has_speed ?? false) || (fp?.has_speed ?? false),
      }
    })
    return { machine: b.machine, families }
  })
}

/** The private export with every public suite, result and image added. */
function mergePublicInto(pub: Data, priv: Data): Data {
  const id = (suite: string) => `private-${suite}`
  const renamed = <T extends { suite: string }>(xs: T[]) => xs.map((x) => ({ ...x, suite: id(x.suite) }))
  const runs = new Map(pub.runs.map((r) => [r.run, r]))
  for (const r of priv.runs) {
    const p = runs.get(r.run)
    const suites = r.suites.map(id)
    runs.set(
      r.run,
      p
        ? {
            ...p,
            suites: [...p.suites, ...suites].sort(),
            models: [...new Set([...p.models, ...r.models])].sort(),
            envs: [...new Set([...p.envs, ...r.envs])],
            records: p.records + r.records,
          }
        : { ...r, suites },
    )
  }
  return {
    ...priv,
    generated_at: [pub.generated_at, priv.generated_at].sort().at(-1)!,
    scope: 'private',
    machines: union((m) => m.key, pub.machines, priv.machines),
    models: union((m) => m.label, pub.models, priv.models).sort((a, b) => a.label.localeCompare(b.label)),
    suites: [...pub.suites, ...priv.suites.map((s) => ({ ...s, id: id(s.id) }))],
    cells: [...pub.cells, ...renamed(priv.cells)],
    perf: [...pub.perf, ...renamed(priv.perf)],
    inproc: [...pub.inproc, ...renamed(priv.inproc)],
    leaderboard: mergeBoards(pub.leaderboard, priv.leaderboard, id),
    results: [...pub.results, ...renamed(priv.results)],
    history: [...pub.history, ...renamed(priv.history)],
    runs: [...runs.values()].sort((a, b) => b.run.localeCompare(a.run)),
    environments: { ...pub.environments, ...priv.environments },
    builds: { ...pub.builds, ...priv.builds },
    corpus: [...pub.corpus, ...priv.corpus.map((m) => ({ ...m, used_by: renamed(m.used_by) }))],
  }
}

// The private site needs the public export too, so it is built first.
const exports: Scope[] = scopes.includes('private') ? ['public', 'private'] : ['public']
for (const scope of exports) step('bun', ['scripts/export-site.ts'], ROOT, { EVALS_SCOPE: scope })
if (scopes.includes('private')) {
  const read = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as Data
  writeFileSync(PRIVATE_DATA, JSON.stringify(mergePublicInto(read(PUBLIC_DATA), read(PRIVATE_DATA))))
  // The public images the merged results show: corpus images and edited images.
  for (const dir of ['corpus', 'results']) {
    const from = join(ROOT, 'site', 'public', dir)
    if (existsSync(from)) cpSync(from, join(ROOT, 'private', 'site', 'public', dir), { recursive: true })
  }
}

for (const scope of scopes) {
  const env = { EVALS_SCOPE: scope, SITE_SCOPE: scope }
  console.log(`== ${scope} site`)
  step('bunx', ['astro', 'build'], join(ROOT, 'site'), env)
  console.log(`→ ${scope === 'private' ? 'private/site/dist' : 'site/dist'}`)
}

if (serve) {
  if (!scopes.includes('private')) throw new Error('--serve serves the private site; pass private')
  // Live-streaming, long-lived server: inherits stdio, so it bypasses the
  // command seam (CLAUDE.md exception). Bound to 127.0.0.1, never the LAN.
  const p = Bun.spawn(['bunx', 'astro', 'preview', '--host', '127.0.0.1', '--port', String(PRIVATE_PORT)], {
    cwd: join(ROOT, 'site'),
    env: { ...process.env, SITE_SCOPE: 'private' },
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  process.exit(await p.exited)
}
