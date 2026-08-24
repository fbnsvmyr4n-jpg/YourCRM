# Adaptive solar login — decision log

§30 asks for a short record of what was rejected and why, so a later pass does
not re-litigate it. Written as decisions, not as a change log.

## Measured performance (24 Aug 2026)

Per-frame CPU cost of the environment, measured with `process.hrtime` over
50,000 iterations after a 2,000-iteration warm-up:

| operation                                 | cost        | share of a 60fps frame |
| ----------------------------------------- | ----------- | ---------------------- |
| `solarSnapshot` — position + event times  | 4.162 µs    | 0.025%                 |
| `moonSnapshot`                            | 2.783 µs    | 0.017%                 |
| `environmentFor` — model + projection     | 0.385 µs    | 0.002%                 |
| `scenePalette` — every colour             | 3.024 µs    | 0.018%                 |
| **`EnvironmentClock.tick()` — one frame** | **9.27 µs** | **0.056%**             |

**Not measured: end-to-end frame rate in a real browser.** The automation pane
runs as a hidden tab, where `requestAnimationFrame` never fires, so any figure
reported from it would be fabricated. That needs a foreground window on a real
device. The low-power detector measures exactly this at runtime and latches, so
the first genuinely slow device to load the page cuts its own scene back without
anyone having to profile it.

The number that matters is that the JavaScript is not the cost. Everything
expensive is either cached — solar events, keyed on calendar day and rounded
coordinates — or handed to the compositor as custom properties. Any real
performance problem will be fill rate: blurs and large gradients, which is
exactly what low-power mode drops.

## Cloud drift rate

A lap every **two hours**, and the phase is a function of the hour and the
minute rather than of elapsed frames — so the clouds are where the clock says
they are: reproducible, identical on every device at the same moment, and
continuous across a reload instead of snapping back to wherever the page
started. Two hours also divides the day cleanly, so the pattern repeats on a
whole hour rather than at an arbitrary offset from an epoch nobody chose.

Three degrees of longitude a minute works out at a little under **one pixel per
second** on a 1100-pixel frame. The first attempt wrapped in twenty minutes —
about five pixels a second — and that is above the threshold where ambient
movement stops being ambient: the eye locks on and tracks it. On a page where
somebody is trying to read a password field, that is a cost rather than a
flourish.

If this is ever retuned, the number to reason about is pixels per second on
screen, not minutes per lap. The lap time means nothing without the field of
view and the display width.

## Rejected

**Weather (§17).** Optional in the specification; out of scope here. The login
screen is the one page that must work when everything else is down, and weather
adds an outbound request to a third party on it. "Optional" in a spec becomes
"built late, without the caching discipline".

**shadcn/ui (§4).** Not in this project and deliberately rejected during the
audit — it would make a custom design system generic, and that design system is
this product's strongest asset.

**`@types/suncalc`.** Describes the 1.x radians API. The package ships its own
types, which match what it actually returns. A type definition that contradicts
its library is worse than none.

**Radians, azimuth from south (§6).** SunCalc's README documents them; version
2.0.1 returns degrees as a compass bearing from north. Following the
documentation converts degrees to degrees and yields an altitude of 2390° —
finite, not NaN, and passing every check that does not know the answer.

**A flag to hide the developer panel (§19).** A flag is a variable somebody can
set on the wrong deployment, and the panel overrides location and time. The
bundler excludes it and a test searches the build output.

**Damping the projection's antipode discontinuity.** At 180° behind the camera,
left and right are the same place. That is what "behind you" means to a single
camera; damping it would be a lie about where the body is. A field of view under
360° puts it off-screen instead.

**Flipping to dark text on a bright sky.** The obvious way to hold contrast, and
it would end the illusion: §16 wants one material under changing light, not two
designs that swap over. The wash deepens instead.

**A card or panel behind the form.** The fields sit directly on the sky, which is
most of why the screen reads as a window. Readability is a wide edgeless wash,
not a rectangle.

## Settled

- **Vantage:** from orbit. The Earth's limb is the horizon; the sun and moon sit
  behind it and are occulted by the planet.
- **Camera:** faces the sun's own bearing at solar noon, read from the sky, so
  the equator needs no special case.
- **Field of view:** 220° horizontal — wider than any real lens, deliberately. A
  realistic one holds the sun for about three hours of a twelve-hour day.
- **Coordinates:** rounded to 0.1° at entry and never sent to the server, so
  full-precision GPS never exists anywhere in the system.
- **Default location:** Cape Town, when every rung of the ladder fails.

## Defects found by using it, not by reading it

- **React owned the style attribute** the clock wrote to, so every render wiped
  the whole palette and left a night sky in broad daylight. Repaired a frame
  later — and not at all on a hidden tab, which is how it was spotted.
- **The haze layer had a 0.25 opacity floor** and its colour did not dim with
  brightness, painting light blue across the bottom of the frame at midnight.
  Haze is scattered sunlight; with no sun there is none.
- **`approach` returned the target when no time had passed**, so a backward
  clock step — an NTP correction, the end of daylight saving — snapped the scene
  instead of leaving it still.
- **Colour mixes were written backwards**, putting a 45% orange wash over a
  midday sky.
- **The collapsed simulator chip froze at mount**, reporting a phase the scene
  had long left.
