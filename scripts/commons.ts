// Small shared helpers for talking to Wikimedia Commons and downloading, used by
// scripts/fetch-corpus.ts (images) and scripts/fetch-av.ts (audio and video).

export const UA = 'small-model-evals/0.1 (local eval corpus; https://github.com/sksizer/small-model-evals)'

export const stripHtml = (s: string) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

/** A Commons API query, politely paced and retried when rate limited. */
export async function api(params: Record<string, string>): Promise<unknown> {
  const url = new URL('https://commons.wikimedia.org/w/api.php')
  for (const [k, v] of Object.entries({ action: 'query', format: 'json', ...params })) url.searchParams.set(k, v)
  for (let attempt = 0; attempt < 3; attempt++) {
    await Bun.sleep(2500)
    const res = await fetch(url, { headers: { 'User-Agent': UA } })
    const text = await res.text()
    if (text.startsWith('{')) return JSON.parse(text)
    await Bun.sleep(30_000) // rate limited
  }
  throw new Error(`Commons API kept refusing: ${url}`)
}

export async function download(url: string): Promise<Uint8Array> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await Bun.sleep(2500)
    const res = await fetch(url, { headers: { 'User-Agent': UA } })
    if (res.ok) return new Uint8Array(await res.arrayBuffer())
    if (res.status !== 429) throw new Error(`${url}: HTTP ${res.status}`)
    await Bun.sleep(30_000)
  }
  throw new Error(`${url}: kept rate-limiting`)
}
