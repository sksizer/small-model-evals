// The transformations that make the similarity suite's `copy` images:
// scripts/fetch-corpus.ts applies them, scripts/pick-similarity.ts names them.
// Each keeps a photo recognisably the same photo, and each is deterministic
// (the committed output bytes are what the suite uses, so a later sharp
// version cannot move them).
import type { Sharp } from 'sharp'

export const RECIPES = {
  /** Half the width, quality 85. */
  resize: (img, width) => img.resize({ width: Math.round(width / 2) }).jpeg({ quality: 85 }),
  /** Same size, quality 40. */
  jpeg40: (img) => img.jpeg({ quality: 40 }),
  /** 5% off each edge: 10% of each dimension gone. */
  crop10: (img, width, height) => {
    const dx = Math.round(width * 0.05)
    const dy = Math.round(height * 0.05)
    return img.extract({ left: dx, top: dy, width: width - 2 * dx, height: height - 2 * dy }).jpeg({ quality: 88 })
  },
  /** Mirrored left to right. */
  flip: (img) => img.flop().jpeg({ quality: 88 }),
  /** 30% brighter. */
  bright: (img) => img.modulate({ brightness: 1.3 }).jpeg({ quality: 88 }),
} satisfies Record<string, (img: Sharp, width: number, height: number) => Sharp>

export type Recipe = keyof typeof RECIPES
