// What the mflux image editors need from a machine, shared by the setup
// script and the runner: Apple silicon, the mflux CLI on PATH, and the pinned
// weights under .cache/models/<repo>/<revision> (where providers/mflux-edit.ts
// reads them).
import { join } from 'node:path'
import { ROOT } from './ledger.ts'
import type { ModelEntry } from './models.ts'

/** The mflux release the edit suite was built and run with. */
export const MFLUX_VERSION = '0.24.0'
const COMMAND = 'mflux-generate-flux2-edit'

/** Why mflux editors cannot run here, or null when they can (weights aside). */
export function mfluxProblem(): string | null {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return 'mflux (MLX) runs only on Apple silicon; skipped on this machine'
  if (!Bun.which(COMMAND)) return `\`${COMMAND}\` is not on PATH: run \`uv tool install mflux==${MFLUX_VERSION}\``
  return null
}

/** Where a pinned mflux model's weights live. */
export const mfluxWeights = (m: ModelEntry): string => join(ROOT, '.cache', 'models', m.tag, m.revision!)
