// "Let me view" on a sensitive image (components/Shot.astro): clicking loads
// and shows that one image. The page carries its address only as data-src /
// data-href, so nothing shows unless this runs. Nothing is remembered; a
// reload covers it again.
document.addEventListener('click', (e) => {
  const button = (e.target as Element | null)?.closest('.shot-frame .reveal')
  if (!button) return
  e.preventDefault()
  const frame = button.closest('.shot-frame')!
  const img = frame.querySelector<HTMLImageElement>('img[data-src]')
  const link = frame.querySelector<HTMLAnchorElement>('a[data-href]')
  if (img) img.src = img.dataset['src']!
  if (link) link.href = link.dataset['href']!
  frame.classList.remove('censored')
})
