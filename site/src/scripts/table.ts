// Sorting, search and filters for any `table[data-table]` on the page.
//
// - A header with `data-sort` sorts on click: `num` compares each cell's
//   `data-value`, `text` its text. A second click reverses.
// - An input with `data-search="<table id>"` hides rows whose text lacks
//   every typed word.
// - A select with `data-facet="<table id>"` and `name="<key>"` keeps rows
//   whose `data-<key>` equals the chosen value. An empty value, or an option
//   marked `data-all`, keeps all (use `data-all` when the default is a filter,
//   so "all" survives in the URL).
// - A row with `data-toggle` opens the detail row after it.
// - `[data-count="<table id>"]` shows how many rows are visible.
//
// Filter state is kept in the URL query so a filtered view can be shared.

function rowsOf(table: HTMLTableElement): HTMLTableRowElement[] {
  return [...table.tBodies[0]!.rows].filter((r) => !r.classList.contains('detail'))
}

function detailOf(row: HTMLTableRowElement): HTMLTableRowElement | null {
  const next = row.nextElementSibling
  return next instanceof HTMLTableRowElement && next.classList.contains('detail') ? next : null
}

function apply(table: HTMLTableElement): void {
  const id = table.id
  const words = (document.querySelector<HTMLInputElement>(`[data-search="${id}"]`)?.value ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  const facets = [...document.querySelectorAll<HTMLSelectElement>(`[data-facet="${id}"]`)].filter(
    (s) => s.value && !s.selectedOptions[0]?.hasAttribute('data-all'),
  )
  let shown = 0
  for (const row of rowsOf(table)) {
    const text = (row.dataset['search'] ?? row.textContent ?? '').toLowerCase()
    const visible = words.every((w) => text.includes(w)) && facets.every((s) => row.dataset[s.name] === s.value)
    row.hidden = !visible
    const detail = detailOf(row)
    if (detail && !visible) detail.hidden = true
    if (visible) shown++
  }
  const count = document.querySelector(`[data-count="${id}"]`)
  if (count) count.textContent = `${shown} of ${rowsOf(table).length}`
  const params = new URLSearchParams(location.search)
  const search = document.querySelector<HTMLInputElement>(`[data-search="${id}"]`)
  if (search) (search.value ? params.set('q', search.value) : params.delete('q'))
  for (const s of document.querySelectorAll<HTMLSelectElement>(`[data-facet="${id}"]`)) {
    s.value ? params.set(s.name, s.value) : params.delete(s.name)
  }
  const query = params.toString()
  history.replaceState(null, '', query ? `?${query}` : location.pathname)
}

function sortBy(table: HTMLTableElement, th: HTMLTableCellElement): void {
  const index = [...th.parentElement!.children].indexOf(th)
  const numeric = th.dataset['sort'] === 'num'
  const dir = th.dataset['dir'] === 'asc' ? 'desc' : 'asc'
  for (const other of table.tHead!.querySelectorAll('th')) delete other.dataset['dir']
  th.dataset['dir'] = dir
  const key = (row: HTMLTableRowElement) => {
    const cell = row.cells[index]!
    if (!numeric) return cell.dataset['value'] ?? cell.textContent?.trim().toLowerCase() ?? ''
    const n = Number(cell.dataset['value'])
    return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY
  }
  const body = table.tBodies[0]!
  const pairs = rowsOf(table).map((row) => [row, detailOf(row)] as const)
  pairs.sort(([a], [b]) => {
    const [x, y] = [key(a), key(b)]
    const order = x < y ? -1 : x > y ? 1 : 0
    return dir === 'asc' ? order : -order
  })
  for (const [row, detail] of pairs) {
    body.append(row)
    if (detail) body.append(detail)
  }
}

for (const table of document.querySelectorAll<HTMLTableElement>('table[data-table]')) {
  const params = new URLSearchParams(location.search)
  const search = document.querySelector<HTMLInputElement>(`[data-search="${table.id}"]`)
  if (search && params.get('q')) search.value = params.get('q')!
  search?.addEventListener('input', () => apply(table))
  for (const s of document.querySelectorAll<HTMLSelectElement>(`[data-facet="${table.id}"]`)) {
    if (params.get(s.name)) s.value = params.get(s.name)!
    s.addEventListener('change', () => apply(table))
  }
  for (const th of table.tHead?.querySelectorAll<HTMLTableCellElement>('th[data-sort]') ?? []) {
    th.tabIndex = 0
    th.addEventListener('click', () => sortBy(table, th))
    th.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        sortBy(table, th)
      }
    })
  }
  table.addEventListener('click', (e) => {
    const row = (e.target as Element).closest<HTMLTableRowElement>('tr[data-toggle]')
    if (!row || (e.target as Element).closest('a')) return
    const detail = detailOf(row)
    if (!detail) return
    detail.hidden = !detail.hidden
    row.setAttribute('aria-expanded', String(!detail.hidden))
  })
  apply(table)
}
