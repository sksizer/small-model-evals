// Drawn patterns that look like a barcode or QR code but encode nothing.
function rng(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }
function barcode(el, seed) {
  const r = rng(seed); let x = 0, html = '';
  while (x < 300) { const w = 1 + Math.floor(r() * 4), gap = 1 + Math.floor(r() * 3); html += `<i style="position:absolute;left:${x}px;top:0;width:${w}px;height:100%;background:#000"></i>`; x += w + gap; }
  el.style.position = 'relative'; el.style.width = x + 'px'; el.innerHTML = html;
}
function qr(el, n, cell, seed) {
  const r = rng(seed); const finder = (i, j) => [[0, 0], [0, n - 7], [n - 7, 0]].some(([a, b]) => i >= a && i < a + 7 && j >= b && j < b + 7);
  const f = (i, j) => { for (const [a, b] of [[0, 0], [0, n - 7], [n - 7, 0]]) { const u = i - a, v = j - b; if (u >= 0 && u < 7 && v >= 0 && v < 7) { const m = Math.max(Math.abs(u - 3), Math.abs(v - 3)); return m === 3 || m <= 1; } } return false; };
  let html = '';
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const on = finder(i, j) ? f(i, j) : r() > 0.52; html += `<i style="width:${cell}px;height:${cell}px;background:${on ? '#000' : '#fff'}"></i>`; }
  el.style.display = 'grid'; el.style.gridTemplateColumns = `repeat(${n},${cell}px)`; el.innerHTML = html;
}
