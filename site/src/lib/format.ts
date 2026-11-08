// Formatting helpers with no data dependency, so both the pages (via data.ts)
// and client scripts (scripts/finder.ts) can use them without bundling evals.json.

/** What a time is per: one image or one text item embedded (the provider's own measure) or one case (the case's latency). */
export type TimePer = 'image' | 'item' | 'case'

/** A URL-safe slug for a model label such as `qwen3.5:4b`. */
export const modelSlug = (label: string) => label.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')

/** A parameter count as people write it: 137M, 4.0B. */
export const fmtParams = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : n >= 1e9 ? `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B` : `${Math.round(n / 1e6)}M`

/** A download size in GB or MB. */
export const fmtDisk = (gb: number | null | undefined) =>
  gb === null || gb === undefined ? '—' : gb >= 1 ? `${gb.toFixed(1)} GB` : gb >= 0.01 ? `${Math.round(gb * 1000)} MB` : `${(gb * 1000).toFixed(2)} MB`

export const pct = (passed: number, total: number) => (total === 0 ? 0 : Math.round((100 * passed) / total))
export const fmt = (n: number | null | undefined, digits = 1) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toFixed(digits))
/** A time as people read it: ms below a second, else seconds; "/img" when it is per image, "/item" per text item. */
export const fmtTime = (ms: number | null | undefined, per: TimePer = 'case') => {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  const t = ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : ms >= 10 ? `${Math.round(ms)} ms` : `${ms.toFixed(1)} ms`
  return per === 'image' ? `${t}/img` : per === 'item' ? `${t}/item` : t
}

/** A tone for a pass rate, for heat-coloured cells. */
export const tone = (rate: number) => (rate >= 90 ? 'good' : rate >= 70 ? 'ok' : rate >= 50 ? 'warn' : 'bad')
