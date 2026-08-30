/**
 * Seeded-noise image generator, shared by `skia.s3.texture_churn` and
 * `list.scroll` (ticket T06 scope: "generated images (seeded noise, created
 * at scene start -- no bundled assets)"). Draws deterministic colored-noise
 * squares directly onto CPU-backed offscreen Skia surfaces via the
 * imperative `SkCanvas` API (`Skia.Surface.Make` + `drawRect`), then
 * snapshots each into an `SkImage` -- no React render tree, no bundled PNG
 * assets, so every image is generated fresh from the mulberry32 PRNG
 * (seededRandom.ts) each scene run.
 */

import { Skia, type SkImage } from '@shopify/react-native-skia';
import { mulberry32, randInt } from './seededRandom';

/** Grid cell size (px) used when tiling noise onto one generated image -- small enough that each image is visually distinct from the next, large enough that generation stays fast for a few hundred images. */
const NOISE_CELL_PX = 8;

/**
 * Generates `count` square `size`x`size` noise images from `seed`, each
 * texture visually distinct (deterministic across platforms and runs given
 * the same seed) so `skia.s3.texture_churn` and `list.scroll` have real,
 * uncacheable-looking image content without shipping any bundled asset.
 * Returns `null` for any image whose offscreen surface allocation fails
 * (SkSurface.Make can return null under memory pressure) rather than
 * throwing -- callers should filter/handle nulls.
 */
export function generateNoiseImages(count: number, size: number, seed: number): (SkImage | null)[] {
  const rand = mulberry32(seed);
  const images: (SkImage | null)[] = [];
  for (let i = 0; i < count; i++) {
    images.push(generateOneNoiseImage(size, rand));
  }
  return images;
}

function generateOneNoiseImage(size: number, rand: () => number): SkImage | null {
  const surface = Skia.Surface.Make(size, size);
  if (!surface) return null;

  const canvas = surface.getCanvas();
  const paint = Skia.Paint();

  // Solid base so every cell is opaque (avoids a transparent image that
  // would make the churn scene's "fresh texture upload" cost cheaper than
  // real-world opaque photo/avatar content).
  paint.setColor(Skia.Color(`rgb(${randInt(rand, 0, 255)}, ${randInt(rand, 0, 255)}, ${randInt(rand, 0, 255)})`));
  canvas.drawRect(Skia.XYWHRect(0, 0, size, size), paint);

  for (let y = 0; y < size; y += NOISE_CELL_PX) {
    for (let x = 0; x < size; x += NOISE_CELL_PX) {
      paint.setColor(
        Skia.Color(`rgb(${randInt(rand, 0, 255)}, ${randInt(rand, 0, 255)}, ${randInt(rand, 0, 255)})`),
      );
      canvas.drawRect(Skia.XYWHRect(x, y, NOISE_CELL_PX, NOISE_CELL_PX), paint);
    }
  }

  surface.flush();
  return surface.makeImageSnapshot();
}
