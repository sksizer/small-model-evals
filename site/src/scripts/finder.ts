// The model finder page (pages/finder.astro): filters, sorts and totals the rows
// the page embeds, and keeps the whole view in the URL query so it can be shared.
//
// Query keys: t (task ids, comma separated), q, params, mem, min, speed, kind
// (comma separated), perm=1, base=0, ret=1, machine, fits, sort, dir. A key that is
// absent means that filter is off (base is on unless base=0); `machine` falls back to the
// machine picked on the last visit, and `fits` to the class of the chosen machine (`fits=any`
// turns the badge off): every model shows its fit badge for that class. Nothing is hidden by
// default; `nofit=1` hides the models that will not fit it.
import { fmt, fmtDisk, fmtParams, fmtTime, modelSlug, tone } from '../lib/format'
import { FIT_WORDS, type FinderRow, type FinderTask, type FitStatus } from '../lib/data'
import { remember, remembered } from './machine-pick'

const payload = JSON.parse(document.getElementById('finder-data')!.textContent!) as { base: string; tasks: FinderTask[]; rows: FinderRow[]; machines: { key: string; class: string }[] }
const { base, tasks, rows, machines } = payload
const classOfMachine = new Map(machines.map((m) => [m.key, m.class]))
/** The class to test fit against until the viewer picks another: the chosen machine's own. */
const defaultFits = (machine: string) => classOfMachine.get(machine) ?? ''
const taskById = new Map(tasks.map((t) => [t.id, t]))

const table = document.getElementById('finder-table') as HTMLTableElement
const count = document.getElementById('finder-count')!
const field = (key: string) => document.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-f="${key}"]`)
const toggle = (key: string) => document.querySelector<HTMLInputElement>(`input[data-f="${key}"]`)!
const taskBoxes = [...document.querySelectorAll<HTMLInputElement>('input[data-task]')]
const kindBoxes = [...document.querySelectorAll<HTMLInputElement>('input[data-kind]')]

interface State {
  tasks: string[]
  q: string
  params: string
  mem: string
  min: string
  speed: string
  kinds: string[]
  perm: boolean
  base: boolean
  ret: boolean
  machine: string
  /** The class whose fit each model's badge shows; '' for none. */
  fits: string
  /** Hide models that will not fit that class. */
  nofit: boolean
  sort: string
  dir: 'asc' | 'desc'
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const list = (v: string | null) => (v ? v.split(',').filter(Boolean) : [])

function read(): State {
  const p = new URLSearchParams(location.search)
  const wanted = p.get('machine') ?? remembered() ?? ''
  const machine = classOfMachine.has(wanted) ? wanted : (machines[0]?.key ?? '')
  const fits = p.get('fits')
  return {
    tasks: list(p.get('t')).filter((t) => taskById.has(t)),
    q: p.get('q') ?? '',
    params: p.get('params') ?? '',
    mem: p.get('mem') ?? '',
    min: p.get('min') ?? '',
    speed: p.get('speed') ?? '',
    kinds: list(p.get('kind')),
    perm: p.get('perm') === '1',
    base: p.get('base') !== '0',
    ret: p.get('ret') === '1',
    machine,
    nofit: p.get('nofit') === '1',
    fits: fits === null ? defaultFits(machine) : fits === 'any' ? '' : fits,
    sort: p.get('sort') ?? 'avg',
    dir: p.get('dir') === 'asc' ? 'asc' : 'desc',
  }
}

/** Put a state into the controls (on load). */
function show(s: State): void {
  for (const b of taskBoxes) b.checked = s.tasks.includes(b.value)
  for (const b of kindBoxes) b.checked = s.kinds.includes(b.value)
  const set = (k: string, v: string) => { const f = field(k); if (f) f.value = v }
  set('q', s.q); set('params', s.params); set('mem', s.mem); set('min', s.min); set('speed', s.speed)
  if (s.machine) set('machine', s.machine)
  set('fits', s.fits)
  toggle('nofit').checked = s.nofit
  toggle('perm').checked = s.perm
  toggle('base').checked = s.base
  toggle('ret').checked = s.ret
}

/** Read the controls, keeping the sort from the previous state. */
function collect(prev: State): State {
  const v = (k: string) => field(k)?.value ?? ''
  return {
    ...prev,
    tasks: taskBoxes.filter((b) => b.checked).map((b) => b.value),
    q: v('q').trim(),
    params: v('params'),
    mem: v('mem'),
    min: v('min'),
    speed: v('speed'),
    kinds: kindBoxes.filter((b) => b.checked).map((b) => b.value),
    perm: toggle('perm').checked,
    base: toggle('base').checked,
    ret: toggle('ret').checked,
    machine: v('machine') || prev.machine,
    nofit: toggle('nofit').checked,
    // Changing machine moves the fit class with it, unless the viewer chose another class.
    fits: v('machine') && v('machine') !== prev.machine && prev.fits === defaultFits(prev.machine) ? defaultFits(v('machine')) : v('fits'),
  }
}

function write(s: State): void {
  const p = new URLSearchParams()
  if (s.tasks.length) p.set('t', s.tasks.join(','))
  if (s.q) p.set('q', s.q)
  for (const k of ['params', 'mem', 'min', 'speed'] as const) if (s[k]) p.set(k, s[k])
  if (machines.length > 1 && s.machine) p.set('machine', s.machine)
  if (s.nofit) p.set('nofit', '1')
  if (s.fits !== defaultFits(s.machine)) p.set('fits', s.fits || 'any')
  if (s.kinds.length) p.set('kind', s.kinds.join(','))
  if (s.perm) p.set('perm', '1')
  if (!s.base) p.set('base', '0')
  if (s.ret) p.set('ret', '1')
  if (s.sort !== 'avg' || s.dir !== 'desc') { p.set('sort', s.sort); p.set('dir', s.dir) }
  const q = p.toString()
  history.replaceState(null, '', q ? `?${q}` : location.pathname)
}

/** The figures a row shows for the chosen tasks (all it ran when none is chosen). */
function figures(r: FinderRow, chosen: string[]) {
  const cells = chosen.length > 0 ? chosen.map((t) => r.cells[t]!) : Object.values(r.cells)
  const avg = cells.reduce((sum, c) => sum + c.rate, 0) / cells.length
  const rels = chosen.length > 0 ? chosen.map((t) => r.cells[t]!.rel) : []
  const speed = rels.length > 0 && rels.every((x) => x !== null) ? Math.max(...(rels as number[])) : null
  const worst = Math.min(...cells.map((c) => c.rate))
  return { avg, speed, worst }
}

function keep(r: FinderRow, s: State, f: ReturnType<typeof figures>): boolean {
  if (s.machine && r.machine !== s.machine) return false
  if (s.nofit && s.fits && r.fits[s.fits] === 'wont') return false
  if (!s.base && r.baseline) return false
  if (!s.ret && r.retired) return false
  if (s.perm && !r.permissive) return false
  if (s.kinds.length > 0 && !s.kinds.includes(r.kind ?? '')) return false
  if (s.params && !(r.parameters !== null && r.parameters <= Number(s.params))) return false
  if (s.mem && !(r.memory !== null && r.memory.gb <= Number(s.mem))) return false
  if (s.min && !(f.worst >= Number(s.min))) return false
  if (s.speed && s.tasks.length > 0 && !(f.speed !== null && f.speed <= Number(s.speed))) return false
  const words = s.q.toLowerCase().split(/\s+/).filter(Boolean)
  const text = [r.model, r.publisher, r.kind, r.licence].join(' ').toLowerCase()
  return words.every((w) => text.includes(w))
}

/** A sort key per column; null sorts last whichever way the sort runs. */
function key(r: FinderRow, f: ReturnType<typeof figures>, sort: string): number | string | null {
  if (sort.startsWith('t:')) return r.cells[sort.slice(2)]?.rate ?? null
  switch (sort) {
    case 'model': return r.model.toLowerCase()
    case 'kind': return r.kind ?? null
    case 'params': return r.parameters
    case 'mem': return r.memory?.gb ?? null
    case 'fit': return r.need.gib
    case 'disk': return r.disk_gb
    case 'licence': return r.licence?.toLowerCase() ?? null
    case 'speed': return f.speed
    default: return f.avg
  }
}

const BASIS = { loaded: 'loaded', rss: 'rss ≤', peak: 'peak' } as const

function head(s: State): string {
  const th = (sortKey: string, label: string, cls = '', title = '') => {
    const dir = s.sort === sortKey ? ` data-dir="${s.dir}"` : ''
    return `<th data-sort="${esc(sortKey)}" class="${cls}"${dir}${title ? ` title="${esc(title)}"` : ''} tabindex="0">${label}</th>`
  }
  return `<tr>${th('model', 'Model', 'pin')}${th('kind', 'Kind')}${th('params', 'Params', 'num', 'Total weights')}${th('mem', 'Memory', 'num', 'Measured while it ran; see the note below')}${th('fit', 'Fits', '', 'Whether its memory need fits the class picked under Fits on; sorted by the need')}${th('disk', 'Disk', 'num', 'Download size')}${th('licence', 'Licence')}${s.tasks.map((t) => th(`t:${t}`, esc(taskById.get(t)!.label), 'num task-h', taskById.get(t)!.about)).join('')}${th('speed', 'Slowdown', 'num', 'Time over the fastest model on the same task, worst over the ticked tasks')}${th('avg', 'Average', 'num', 'Mean pass rate over the ticked tasks, or over everything the model ran')}</tr>`
}

function line(r: FinderRow, s: State, f: ReturnType<typeof figures>): string {
  const flags = `${r.baseline ? ` <span class="pill stale" title="${esc(r.baseline)}">baseline</span>` : ''}${r.retired ? ` <span class="pill fail" title="${esc(r.retired)}">retired</span>` : ''}`
  const mem = r.memory ? `${fmtDisk(r.memory.gb)}<small>${BASIS[r.memory.basis]}</small>` : '<span class="muted">—</span>'
  const fit = s.fits ? (r.fits[s.fits] as FitStatus) : null
  const fits = fit ? `<span class="pill fit ${fit}" title="${esc(`${s.fits}: ${r.need.gib === null ? 'need unknown' : `needs ${fmt(r.need.gib, 1)} GiB`} (${r.need.note})`)}">${FIT_WORDS[fit]}</span>${r.need.gib === null ? '' : `<small>${fmt(r.need.gib, 1)} GiB</small>`}` : '<span class="muted">—</span>'
  const cells = s.tasks
    .map((t) => {
      const c = r.cells[t]!
      const rate = Math.round(c.rate)
      return `<td class="heat ${tone(rate)}"><a href="${base}/results/?suite=${encodeURIComponent(t.split(':')[0]!)}&model=${encodeURIComponent(r.model)}">${rate}%</a><small>${c.passed}/${c.total} · ${fmtTime(c.time_ms, c.time_per)}${c.stale ? ' · stale' : ''}</small></td>`
    })
    .join('')
  const speed = f.speed === null ? '<span class="muted">—</span>' : `×${fmt(f.speed, 1)}`
  return `<tr><td class="pin"><a href="${base}/models/${modelSlug(r.model)}/">${esc(r.model)}</a>${flags}<small>${esc(r.publisher ?? '')}${r.released ? ` · ${esc(r.released)}` : ''}</small></td><td style="font-size:12px;white-space:nowrap">${esc(r.kind ?? '—')}</td><td class="num" title="${esc(r.parameters_note ?? '')}">${fmtParams(r.parameters)}</td><td class="num">${mem}</td><td>${fits}</td><td class="num">${fmtDisk(r.disk_gb)}</td><td style="font-size:12px;min-width:7em">${esc(r.licence ?? '—')}</td>${cells}<td class="num">${speed}</td><td class="num"><strong>${Math.round(f.avg)}%</strong>${s.tasks.length === 0 ? `<small>${Object.keys(r.cells).length} task${Object.keys(r.cells).length === 1 ? '' : 's'}</small>` : ''}</td></tr>`
}

let state = read()

function render(): void {
  const s = state
  const out = rows
    .filter((r) => s.tasks.every((t) => r.cells[t]))
    .map((r) => ({ r, f: figures(r, s.tasks) }))
    .filter(({ r, f }) => keep(r, s, f))
  out.sort((a, b) => {
    const [x, y] = [key(a.r, a.f, s.sort), key(b.r, b.f, s.sort)]
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1
    const order = x < y ? -1 : x > y ? 1 : 0
    return (s.dir === 'asc' ? order : -order) || a.r.model.localeCompare(b.r.model)
  })
  table.tHead!.innerHTML = head(s)
  table.tBodies[0]!.innerHTML =
    out.length > 0 ? out.map(({ r, f }) => line(r, s, f)).join('') : `<tr><td class="empty" colspan="${9 + s.tasks.length}">No model matches. Loosen a limit or untick a task.</td></tr>`
  // Models hidden only because they will not fit the chosen class, so the filter is never silent.
  const unfit = rows.filter((r) => s.tasks.every((t) => r.cells[t]) && keep(r, { ...s, nofit: false }, figures(r, s.tasks))).length - out.length
  count.textContent = `${out.length} of ${rows.length} models${unfit > 0 ? ` · ${unfit} hidden: won't fit ${s.fits}` : ''}`
  document.querySelector('[data-kind-summary]')!.textContent = s.kinds.length > 0 ? `Kind: ${s.kinds.length} chosen` : 'Kind: all'
  write(s)
}

function sortBy(th: HTMLElement): void {
  const k = th.dataset['sort']!
  state = { ...state, sort: k, dir: state.sort === k && state.dir === 'desc' ? 'asc' : state.sort === k ? 'desc' : k === 'model' || k === 'kind' || k === 'licence' ? 'asc' : 'desc' }
  render()
}

table.tHead!.addEventListener('click', (e) => {
  const th = (e.target as Element).closest<HTMLElement>('th[data-sort]')
  if (th) sortBy(th)
})
table.tHead!.addEventListener('keydown', (e) => {
  const th = (e.target as Element).closest<HTMLElement>('th[data-sort]')
  if (th && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault()
    sortBy(th)
  }
})
for (const el of document.querySelectorAll<HTMLElement>('#finder-tasks, #finder-filters')) {
  const onChange = () => {
    state = collect(state)
    if (machines.length > 1) remember(state.machine)
    render()
  }
  el.addEventListener('change', onChange)
  el.addEventListener('input', onChange)
}

show(state)
render()
