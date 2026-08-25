# Scene textures

All three are **NASA imagery, in the public domain**, from NASA's Visible Earth
catalogue. No attribution is legally required; it is given because the work
deserves it and because a future reader should be able to find the originals.

| file            | source                                     | original       |
| --------------- | ------------------------------------------ | -------------- |
| `earth-day-*`   | Blue Marble Next Generation, December 2004 | 21600 × 10800  |
| `earth-night-*` | Black Marble 2016 (VIIRS day-night band)   | 13500 × 6750   |
| `earth-clouds-*`| Blue Marble combined cloud composite       | 8192 × 4096    |

Regenerate with `scripts/build-scene-textures.mjs`, which takes the two
originals and emits every tier. The night texture is **not** a plain copy of
its source — see below — so it cannot be reproduced by resizing alone.

**Four tiers, and a progressive upgrade — the top one because of a
measurement, not an ambition.** Tracing the camera's own rays at 5,500km and a
58° field: the planet occupies only the bottom fifth of the frame, and at the
**bottom edge** — its nearest and largest part — an 8K surface renders at
**1.4 screen pixels per texel** on a 4K panel. That is magnification. The
shader was stretching each texel across more than a pixel and there was no more
detail in the file to give it. 16384 × 8192 puts that region at roughly 2.8
texels per pixel, and since the original is 21600 wide even the top tier is a
genuine downsample rather than interpolation.

The night texture upgrades too, and had to. It was 4K while the day went to 8K,
so the night side rendered at **half** the day side's detail — 2.8 screen
pixels per texel — and every coastal city was smeared three pixels out into the
water. That smear is what read as lights in the sea; the imagery has none in the
open ocean at all.

Both arrive *after* the scene is already drawing: night first at 4MB, then the
surface at 9.4MB, sequentially rather than racing. The 16K tier is desktop-only
and additionally gated on window width and `deviceMemory`. Skipped entirely on
`saveData` or a 2G-class connection.

**Two base sets, chosen by device.** The 4K set totals 2.8MB and the 2K set 920KB, on
a page that has to load before anybody can do anything. A phone gains almost
nothing from 4K — the frame is a third the width — and a metered connection
loses real money for it, so `navigator.connection.saveData` is honoured as the
explicit request it is.

**4096 × 2048 is not vanity, it is arithmetic.** At the camera's altitude the
frame spans roughly 68° of longitude. A 2048-wide equirectangular texture holds
2048 texels for all 360°, so 68° is 387 texels stretched across a 1087-pixel
frame — and at the ISS-like altitude this started from, the frame spanned 7.8°,
which is 44 texels across the same 1087 pixels. **25× magnification**, which is
exactly why the planet looked like a low-resolution game asset.

### The night texture's green channel is not colour

It carries a **land-proximity field**, computed at build time from the day
imagery by a distance transform and shipped in a channel the shader had no use
for. Red is the lights; green is how close to land each texel is; blue is unused.
The JPEG is encoded 4:4:4 for this reason — chroma subsampling would average
a data channel over 2×2 blocks and blur the coastline the lights are tested
against.

It exists because of a sweep. Measuring the imagery against a land mask and a
distance transform: **80% of all light over water lies within one texel of a
coast, and light more than 400km offshore is exactly zero.** There are no cities
in the open ocean. What is genuinely out there — gas flares in the Persian Gulf
and the Niger Delta, fishing fleets off Argentina — is real, but a lone amber
point in a black ocean reads as a defect on a login screen whether or not it is
accurate. So it is attenuated with distance, never deleted.

Deleting it was the obvious fix and it is a trap: the same sweep named the
brightest "over water" pixels on Earth as **Singapore, Hong Kong, Rio, Helsinki
and Chennai**. They are coastal cities on bays, and a binary land test removes
exactly the night-side landmarks a person would recognise. Hence the dilation —
anything within ~60km of land counts as land — and a long ramp over the next
260km that never reaches zero.

### Water is found by relative blue dominance, not by a difference

`blue - red > k` is the obvious test and it is wrong where the ocean is deepest.
Blue Marble's abyssal plains are nearly black: the mid-Atlantic reads
(2, 7, 23), where blue is three times red and the difference is still only 0.08.
Weighted by latitude that test called **46.1% of Earth land against a true
29.2%** — the deep ocean was classified as land, which put the middle of the
Atlantic 430km from "land" and left it no sun glint.

Dividing by blue removes the brightness dependence, and what appears is not a
tuned constant but a gap: the land fraction is 29.2% at a cut of 0.12 and 30.3%
at 0.36, because almost nothing on Earth scores in between. Ice lands at 0.02,
the Sahara at -0.62, the Amazon at -1.50, deep ocean at 0.70. Both the build
script and the shader use 0.22, the middle of that gap.

### Lights, not a photograph

The night texture is the **city-lights-only** image, not the "land ocean ice"
composite. The composite shows terrain as well as lights, and multiplying that
by an emissive term lit the whole night side — a planet in broad daylight with
the sun sixty degrees below the horizon. City lights have to be lights on black
or they are not emissive, they are a photograph.

They are equirectangular: longitude across, latitude down. The WebGL scene
samples them per-pixel and lights them from the real solar direction, which is
what makes the terminator sweep across actual continents and the city lights
come on where cities actually are.

## stars.bin

**Yale Bright Star Catalogue (BSC5)**, 9,096 stars — every star visible to the
naked eye, down to about seventh magnitude. Compiled at Yale University
Observatory and in the public domain.

Six bytes each: right ascension and declination at sixteen bits, visual
magnitude and colour temperature at eight. **53KB for the entire naked-eye
sky** — less than one of the small texture files.

Sorted brightest first, so a truncated read is still the best stars rather than
an arbitrary slice. The first five decode as Sirius, Canopus, Arcturus, Alpha
Centauri and Vega, which is how the encoding was checked.

The shader converts each to the observer's own horizon using local sidereal
time, so the constellations are the ones actually overhead: the Southern Cross
from Cape Town, the Plough from London. They rise and set through the night
because sidereal time advances — about four minutes a day faster than the
sun's, which is why the sky in June differs from the sky in December.
