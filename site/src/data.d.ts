// evals.json is resolved by the `@data` alias in astro.config.mjs (public or
// private data); src/lib/data.ts gives it its type.
declare module '@data/evals.json' {
  const value: unknown
  export default value
}
