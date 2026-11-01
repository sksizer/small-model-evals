// "Let me view" on a sensitive image (components/Shot.astro): clicking
// unblurs that one image. Nothing is remembered, so a reload blurs it again.
document.addEventListener('click', (e) => {
  const button = (e.target as Element | null)?.closest('.shot-frame .reveal')
  if (!button) return
  e.preventDefault()
  const frame = button.closest('.shot-frame')!
  frame.classList.remove('censored')
  frame.querySelector('a')?.removeAttribute('tabindex')
})
