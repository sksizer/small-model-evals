// The machine picker (layouts/Base.astro): results are per machine and never
// pooled, so a page that holds several machines' results marks each block
// `data-machine="<key>"` and this shows only the chosen machine's. The choice
// is the `machine` address parameter if present, else the one remembered from
// the last visit, else the first machine. A page with no marked block (the
// finder has its own picker) leaves the bar hidden.
export const MACHINE_KEY = 'evals-machine'

export const remembered = (): string | null => {
  try {
    return localStorage.getItem(MACHINE_KEY)
  } catch {
    return null
  }
}

export const remember = (key: string): void => {
  try {
    localStorage.setItem(MACHINE_KEY, key)
  } catch {
    // Private windows can refuse storage; the pick then lasts for the page only.
  }
}

const bar = document.getElementById('machine-bar')
const pick = document.getElementById('machine-pick') as HTMLSelectElement | null
const blocks = [...document.querySelectorAll<HTMLElement>('[data-machine]')]

if (bar && pick && blocks.length > 0) {
  const keys = [...pick.options].map((o) => o.value)
  const wanted = new URLSearchParams(location.search).get('machine') ?? remembered()
  pick.value = wanted && keys.includes(wanted) ? wanted : keys[0]!
  const apply = () => {
    for (const b of blocks) b.classList.toggle('machine-off', b.dataset['machine'] !== pick.value)
  }
  pick.addEventListener('change', () => {
    remember(pick.value)
    apply()
  })
  apply()
  bar.hidden = false
}
