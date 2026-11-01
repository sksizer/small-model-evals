// @ts-check
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'astro/config'

// A static site over the eval ledger. The data is one JSON file written by
// ../scripts/export-site.ts before every build; nothing here reads the ledger.
// SITE_BASE is the path the site is served under, e.g. /small-model-evals
// on GitHub Pages; links go through href() in src/lib/data.ts.
//
// SITE_SCOPE=private builds the private site from ../private/site (data and
// images) into ../private/site/dist, all gitignored; scripts/build-site.ts
// sets it. The public build reads src/data and public/ as usual.
const priv = process.env.SITE_SCOPE === 'private'
/** @param {string} p */
const at = (p) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  output: 'static',
  base: process.env.SITE_BASE ?? '/',
  publicDir: priv ? at('../private/site/public') : at('./public'),
  outDir: priv ? at('../private/site/dist') : at('./dist'),
  vite: {
    resolve: { alias: { '@data': priv ? at('../private/site/data') : at('./src/data') } },
  },
})
