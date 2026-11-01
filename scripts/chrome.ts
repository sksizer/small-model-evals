// The headless Chrome both corpus scripts render with (scripts/fetch-corpus.ts
// renders the synthetic pages; scripts/text-boxes.ts measures their text).
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnRunner } from '@osdlc/command-seam'
import { ROOT } from './ledger.ts'

/** A headless Chrome or Chromium binary: $CHROME, Playwright's cache, or Google Chrome. */
export function chrome(): string {
  if (process.env['CHROME']) return process.env['CHROME']
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright')
  const found = spawnRunner('find').run([cache, '-name', 'chrome-headless-shell', '-type', 'f'], { cwd: ROOT }).stdout.split('\n').filter(Boolean).sort()
  if (found.length > 0) return found.at(-1)!
  const app = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  if (existsSync(app)) return app
  throw new Error('no headless Chrome found; set CHROME')
}
