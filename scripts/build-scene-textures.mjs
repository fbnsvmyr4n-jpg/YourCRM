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
 *   elev  https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73934/
 *           gebco_08_rev_elev_21600x10800.png               21600 x 10800
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

/*
   Elevation, for relief shading.

   PNG rather than JPEG, and that is not a preference. The shader DIFFERENTIATES
   this map to get a surface normal, and differentiation amplifies exactly what
   JPEG throws away — ringing around a coastline becomes a ridge along it, and
   block edges become a grid of creases across flat desert. Lossless at 4k costs
   1.4MB against the 0.64MB a quality-95 JPEG would, which is a cheap price for
   not inventing terrain.

   Two tiers rather than four. Relief is a low-frequency cue: it is the shape of
   a mountain range, not the shape of a ridge, that reads from 5,500km. The 4k
   tier already carries more detail than the frame can resolve.
*/
const BUMP_TIERS = [
  [4096, 2048],
  [2048, 1024],
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

  /*
     The dilation, and it is much tighter than it first looks like it should be.

     60km was the first guess and it was far too generous: it left the oil
     flares off Angola and Cabinda — 108km out, and as bright as a city — at
     91% brightness, which is exactly the lone amber patch in the ocean that
     got reported.

     Measuring instead of guessing gives a startlingly clean split. The
     brightest texel of every coastal city that has to survive this — Singapore,
     Hong Kong, Rio, Helsinki, Chennai, Venice, Dubai — is **0 texels from
     land**. They sit ON land at this resolution; it is only the bilinear
     footprint around them that ever touched water. Meanwhile Angola's flares
     are 22 texels out and the Persian Gulf platforms 25. There is nothing in
     between to get wrong.

     Floored in TEXELS as well as kilometres, because the same field is built
     for the 2K tier where one texel is already 19.6km and a fixed 15km would
     be a sub-texel distance — meaningless, and it would start dimming a
     harbour that merely landed on the wrong side of a pixel.
  */
  const kmPerTexel = 40075 / width;
  const NEAR_KM = Math.max(15, kmPerTexel * 2.5);
  const FAR_KM = NEAR_KM + 105;
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

/*
   The source is a visualisation ramp, not a DEM, and the shader is told so.

   Checked against seven places: Everest reads 241/255, but Denver reads 87
   where a linear 0-8,848m scale would put it at 46, and the Sahara reads 28
   where it should be 12. The curve is concave — lowlands lifted, peaks
   compressed — so a fitted gamma lands anywhere between 0.45 and 0.68
   depending on which pair you fit it to. It is an artistic ramp.
   
   That is fine for what it is used for and would be wrong for anything else.
   Relief shading needs a height field whose gradient tracks slope well enough
   to catch light; it does not need metres. Ocean is a true zero in this source
   — the mid-Atlantic and the Marianas both read 0 — so there is no bathymetry
   to mask out, which is the one thing that would have looked obviously wrong
   from orbit.
*/
for (const [w, h] of BUMP_TIERS) {
  await open("elev-src.png")
    .resize(w, h, { kernel: "lanczos3" })
    .toColourspace("b-w")
    .png({ compressionLevel: 9, palette: false })
    .toFile(`${OUT}/earth-elev-${label(w)}.png`);
  console.log(`elev ${label(w)}`);
}
