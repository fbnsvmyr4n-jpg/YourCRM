# Scene textures

All three are **NASA imagery, in the public domain**, from NASA's Visible Earth
catalogue. No attribution is legally required; it is given because the work
deserves it and because a future reader should be able to find the originals.

| file               | source                                        | original      |
| ------------------ | --------------------------------------------- | ------------- |
| `earth-day.jpg`    | Blue Marble Next Generation, December 2004     | 5400 × 2700   |
| `earth-night.jpg`  | Earth's City Lights (DMSP), city lights only   | 2400 × 1200   |
| `earth-clouds.jpg` | Blue Marble combined cloud composite           | 2048 × 1024   |

Each is downscaled to 2048 × 1024 and re-encoded at quality 72. The planet
occupies a sliver of the login frame, so the full-resolution originals would be
several megabytes spent on detail nobody can see — on the one page that has to
load before anybody can do anything.

The night texture is the **city-lights-only** image, not the "land ocean ice"
composite. The composite shows terrain as well as lights, and multiplying that
by an emissive term lit the whole night side — a planet in broad daylight with
the sun sixty degrees below the horizon. City lights have to be lights on black
or they are not emissive, they are a photograph.

They are equirectangular: longitude across, latitude down. The WebGL scene
samples them per-pixel and lights them from the real solar direction, which is
what makes the terminator sweep across actual continents and the city lights
come on where cities actually are.
