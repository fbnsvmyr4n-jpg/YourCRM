# Scene textures

All three are **NASA imagery, in the public domain**, from NASA's Visible Earth
catalogue. No attribution is legally required; it is given because the work
deserves it and because a future reader should be able to find the originals.

| file            | source                                     | original       |
| --------------- | ------------------------------------------ | -------------- |
| `earth-day-*`   | Blue Marble Next Generation, December 2004 | 5400 × 2700    |
| `earth-night-*` | Black Marble 2016 (VIIRS day-night band)   | 13500 × 6750   |
| `earth-clouds-*`| Blue Marble combined cloud composite       | 8192 × 4096    |

**Two sets, chosen by device.** The 4K set totals 2.8MB and the 2K set 920KB, on
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
