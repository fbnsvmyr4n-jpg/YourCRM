import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

/**
 * The shipped textures are data, and this checks them as data.
 *
 * Everything else about the planet is verified through the shader, which no
 * test can run. These files are the one part of it that can be opened and
 * measured — and one of them now carries a channel that is not colour at all
 * but a computed land-proximity field. A rebuild that silently dropped it, or
 * a build script whose water test regressed, would produce an image that looks
 * completely normal and puts city lights in the middle of the Pacific.
 *
 * Slow by test standards, because it decodes real megapixels. Worth it: this
 * is the only check standing between the build script and what ships.
 */

/* `fileURLToPath`, not `.pathname` — this project lives under a path with a
   space in it, and `.pathname` hands back the percent-encoded form, which sharp
   then cannot open. */
const NIGHT = fileURLToPath(new URL("../public/scene/earth-night-8k.jpg", import.meta.url));
const DAY = fileURLToPath(new URL("../public/scene/earth-day-16k.jpg", import.meta.url));

/** The threshold the shader uses. Kept in step with `shaders.ts`. */
const LIGHT_CUT = 0.24;

const W = 2048;
const H = 1024;

/**
 * The brightest pixel within a small window, not the exact one.
 *
 * A city is a point and these coordinates are approximate — Hong Kong's centre
 * is a few texels wide even at 8K, and a single-texel probe at a reduced
 * sampling grid reads whatever the downsample averaged it into. The first
 * version of this test failed on Hong Kong for exactly that reason, which was
 * the test's resolution and not the texture's. Asking whether a city is lit
 * means asking whether there is light where the city is.
 *
 * The green channel is taken from the same winning pixel, so the mask is read
 * where the light actually is rather than a few texels off it.
 */
const RADIUS = 3;

const sample = async (file: string) => {
  const data = await sharp(file).resize(W, H).raw().toBuffer();
  return (lat: number, lon: number) => {
    const cx = Math.round(((lon + 180) / 360) * W);
    const cy = Math.round(((90 - lat) / 180) * H);
    let best = -1;
    let at = 0;
    for (let dy = -RADIUS; dy <= RADIUS; dy++) {
      const y = Math.min(H - 1, Math.max(0, cy + dy));
      for (let dx = -RADIUS; dx <= RADIUS; dx++) {
        const i = (y * W + ((cx + dx + W) % W)) * 3;
        if (data[i] > best) {
          best = data[i];
          at = i;
        }
      }
    }
    return { r: data[at] / 255, g: data[at + 1] / 255, b: data[at + 2] / 255 };
  };
};

describe("the night texture", () => {
  it("lights the world's cities and leaves the open ocean dark", async () => {
    const at = await sample(NIGHT);

    for (const [name, lat, lon] of [
      ["Tokyo", 35.7, 139.7],
      ["London", 51.5, -0.1],
      ["New York", 40.7, -74.0],
      ["Cairo", 30.0, 31.2],
      ["Delhi", 28.6, 77.2],
    ] as const) {
      expect(at(lat, lon).r, `${name} should be lit`).toBeGreaterThan(LIGHT_CUT);
    }

    /* Darkness is checked with the SAME window, deliberately. `at` returns the
       brightest pixel in it, so "dark" here means not one texel anywhere near
       the open ocean is lit — a strictly stronger claim than probing a single
       point, and the one that matters for a defect described as lights showing
       up in the sea. */
    for (const [name, lat, lon] of [
      ["mid-Pacific", 0, -150],
      ["mid-Atlantic", 30, -40],
      ["Southern Ocean", -55, 0],
      ["central Sahara", 23, 10],
      ["Amazon interior", -4, -63],
    ] as const) {
      expect(at(lat, lon).r, `${name} should be dark`).toBeLessThan(LIGHT_CUT);
    }
  });

  it("keeps coastal cities at full brightness in the land mask", async () => {
    /**
     * The reason the mask is a distance ramp and not a land test.
     *
     * Sweeping the imagery, the BRIGHTEST pixels that a water mask calls water
     * are Singapore, Hong Kong, Rio, Helsinki and Chennai — coastal cities on
     * bays. A binary "no light over water" rule deletes exactly the night-side
     * landmarks a person would recognise, which is worse than the defect it
     * fixes.
     */
    const at = await sample(NIGHT);
    for (const [name, lat, lon] of [
      ["Singapore", 1.3, 103.8],
      ["Hong Kong", 22.3, 114.2],
      ["Rio de Janeiro", -22.9, -43.2],
      ["Helsinki", 60.2, 24.9],
    ] as const) {
      const p = at(lat, lon);
      expect(p.r, `${name} should be lit`).toBeGreaterThan(LIGHT_CUT);
      expect(p.g, `${name} must not be treated as offshore`).toBeGreaterThan(0.7);
    }
  });

  it("marks the open ocean as far from land", async () => {
    const at = await sample(NIGHT);
    for (const [name, lat, lon] of [
      ["mid-Pacific", 0, -150],
      ["North Sea", 57.5, 2.0],
    ] as const) {
      expect(at(lat, lon).g, `${name} should read as open water`).toBeLessThan(0.4);
    }
  });
});

describe("the day texture", () => {
  it("separates land from water by relative blue dominance", async () => {
    /**
     * The measurement that found the real bug, kept as a test.
     *
     * `blue - red > k` is the obvious water test and it fails in the DEEPEST
     * ocean: the mid-Atlantic reads (2, 7, 23), where blue is three times red
     * and the absolute difference is still only 0.08. Weighted by latitude
     * that test called 46.1% of Earth land against a true 29.2% — the deep
     * ocean was being treated as land, and got no sun glint.
     *
     * Dividing by blue removes the brightness dependence. The number below is
     * not a tolerance chosen to pass; it is a physical constant.
     */
    const data = await sharp(DAY).resize(W, H).raw().toBuffer();
    let land = 0;
    let total = 0;

    for (let y = 0; y < H; y++) {
      // Cosine weighting: an equirectangular map stretches the poles enormously,
      // and Antarctica alone would otherwise swing the answer by ten points.
      const weight = Math.cos(((90 - ((y + 0.5) / H) * 180) * Math.PI) / 180);
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 3;
        const r = data[i] / 255;
        const g = data[i + 1] / 255;
        const b = data[i + 2] / 255;
        total += weight;
        if ((b - Math.max(r, g)) / Math.max(b, 0.02) <= 0.22) land += weight;
      }
    }

    // Earth is 29.2% land.
    expect(land / total).toBeGreaterThan(0.26);
    expect(land / total).toBeLessThan(0.33);
  });

  it("is genuinely 16384 wide, not an upscale of the 8K tier", async () => {
    const meta = await sharp(DAY).metadata();
    expect(meta.width).toBe(16384);
    expect(meta.height).toBe(8192);
  });
});
