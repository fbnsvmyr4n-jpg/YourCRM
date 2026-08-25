/**
 * Build the login scene's planet textures from the NASA originals.
 *
 * Kept in the repo because the outputs are not obvious derivatives of their
 * sources — the night texture in particular carries a channel that does not
 * exist in the original — and a future reader who cannot regenerate them has
 * to reverse-engineer three decisions from a JPEG.
 *
 * Sources (public domain, NASA Visible Earth), not committed:
 *   day   https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73909/
 *           world.topo.bathy.200412.3x21600x10800.jpg       21600 x 10800
 *   night https://eoimages.gsfc.nasa.gov/images/imagerecords/144000/144898/
 *           BlackMarble_2016_3km_geo.tif                    13500 x 6750
 *
 *   node scripts/build-scene-textures.mjs <src-dir> <out-dir>
 */
import sharp from "sharp";
import { readFileSync } from "node:fs";

const [, , SRC = ".", OUT = "public/scene"] = process.argv;
const open = (f) => sharp(`${SRC}/${f}`, { limitInputPixels: false });

/*
   Every tier is a DOWNSAMPLE of the original, never an upscale.

   The day source is 21600 wide, so even the 16k tier is a genuine 1.32x
   reduction — Lanczos over real detail rather than interpolation inventing it.
   That is the whole reason the top tier is worth its bytes: measured at the
   camera's altitude, the foreground of the frame renders at 1.4 SCREEN PIXELS
   PER TEXEL against the 8k texture, which means the shader was magnifying and
   there was no more detail in the file to show. 16k puts it back to roughly
   2.8 texels per pixel — oversampled, which is where "sharp" lives.
*/
const DAY_TIERS = [
  [16384, 8192, 80],
  [8192, 4096, 82],
  [4096, 2048, 84],
  [2048, 1024, 86],
];

const NIGHT_TIERS = [
  [8192, 4096, 90],
  [4096, 2048, 92],
  [2048, 1024, 92],
];

/**
 * Land proximity, as a 0..1 field on the equirectangular grid.
 *
 * Shipped in the night texture's GREEN channel, which is otherwise unused —
 * the shader reads lights out of red and has no use for the other two.
 *
 * It exists because of a measurement. Sweeping the night imagery against a
 * land mask and a distance transform: 80% of all light over water lies within
 * one texel of a coast, and light more than 400km offshore is **exactly zero**.
 * There are no cities in the open ocean. What is out there, between roughly 80
 * and 400km, is real — gas flares in the Persian Gulf and the Niger Delta,
 * fishing fleets off Argentina — but on a login screen a lone amber point in a
 * black ocean reads as a defect whether or not it is accurate.
 *
 * So it is attenuated with distance rather than deleted. Deleting it would
 * also have taken Singapore, Rio, Helsinki, Chennai and Hong Kong, which the
 * same sweep identified as the BRIGHTEST "over water" pixels on Earth: they
 * are coastal cities on bays, and a binary land test removes them.
 *
 * Hence the dilation — anything within ~60km of land counts as land — and the
 * long ramp after it.
 */
async function landProximity(width, height) {
  const { data } = await open("day-src.jpg")
    .resize(width, height, { kernel: "lanczos3" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const n = width * height;
  const dist = new Int32Array(n).fill(-1);
  let queue = [];

  /*
     Water from the imagery, not from a shipped mask — but by RELATIVE blue
     dominance, not by a difference.

     The obvious test is `blue - red > k`, and it is wrong in a way that only
     shows up in the deepest ocean. Blue Marble's abyssal plains are nearly
     black: a pixel in the mid-Atlantic reads (2, 7, 23), where blue is three
     times red and yet the *difference* is 0.08 — under any cut that still
     excludes land. So the deep ocean classified as LAND. Weighted by latitude
     the absolute test called 46.1% of Earth land, against a true 29.2%, and
     the practical effect was that the middle of the Atlantic sat 430km from
     "land" and kept its full share of city light.

     Dividing by blue removes the brightness dependence, and the result is not
     a tuned number but a plateau: the land fraction is 29.2% at a threshold of
     0.12 and 30.3% at 0.36, because almost nothing on Earth lies between. Ice
     scores 0.02 and counts as land, the Sahara -0.62, the Amazon -1.50, deep
     ocean 0.70. 0.22 sits in the middle of the gap.
  */
  const WATER_CUT = 0.22;
  for (let p = 0; p < n; p++) {
    const i = p * 3;
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    if ((b - Math.max(r, g)) / Math.max(b, 0.02) <= WATER_CUT) {
      dist[p] = 0;
      queue.push(p);
    }
  }

  // Breadth-first from every land texel at once: one pass for the whole globe.
  // Longitude wraps, latitude does not — the poles are not adjacent.
  for (let d = 0; queue.length; d++) {
    const next = [];
    for (const p of queue) {
      const x = p % width;
      const y = (p / width) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = (x + dx + width) % width;
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        const np = ny * width + nx;
        if (dist[np] < 0) {
          dist[np] = d + 1;
          next.push(np);
        }
      }
    }
    queue = next;
  }

  const kmPerTexel = 40075 / width;
  const NEAR_KM = 60; // a coastal city, its harbour, and its bay
  const FAR_KM = 320; // open water, where nothing is a city
  const out = Buffer.alloc(n);
  for (let p = 0; p < n; p++) {
    const km = dist[p] * kmPerTexel;
    const t = Math.min(1, Math.max(0, (km - NEAR_KM) / (FAR_KM - NEAR_KM)));
    out[p] = Math.round((1 - t * t * (3 - 2 * t)) * 255);
  }
  return out;
}

async function buildNight(width, height, quality) {
  /* Red, not luminance. This source is not lights on black — it paints the
     dark side a deep blue, and the blue channel's mean is 29/255 against red's
     12.9. Red is the least contaminated carrier of the lights themselves. */
  const lights = await open("night-src.tif")
    .extractChannel("red")
    .resize(width, height, { kernel: "lanczos3" })
    .raw()
    .toBuffer();

  const land = await landProximity(width, height);
  const blue = Buffer.alloc(width * height);

  await sharp(interleave(lights, land, blue, width * height), {
    raw: { width, height, channels: 3 },
  })
    /* 4:4:4. Chroma subsampling averages colour over 2x2 blocks, and two of
       these three channels are DATA rather than colour — a halved land mask
       would blur the coastline the lights are being tested against. */
    .jpeg({ quality, chromaSubsampling: "4:4:4" })
    .toFile(`${OUT}/earth-night-${label(width)}.jpg`);
}

function interleave(r, g, b, n) {
  const out = Buffer.alloc(n * 3);
  for (let p = 0; p < n; p++) {
    out[p * 3] = r[p];
    out[p * 3 + 1] = g[p];
    out[p * 3 + 2] = b[p];
  }
  return out;
}

const label = (w) => `${w / 1024}k`;

const only = process.env.ONLY_NIGHT ? [] : DAY_TIERS;
for (const [w, h, q] of only) {
  await open("day-src.jpg")
    .resize(w, h, { kernel: "lanczos3" })
    .jpeg({ quality: q, mozjpeg: true })
    .toFile(`${OUT}/earth-day-${label(w)}.jpg`);
  console.log(`day ${label(w)}`);
}

for (const [w, h, q] of NIGHT_TIERS) {
  await buildNight(w, h, q);
  console.log(`night ${label(w)}`);
}
