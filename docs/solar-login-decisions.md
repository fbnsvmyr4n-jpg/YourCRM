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

## 31. The palette was never reaching the form

Bradley reported the two lines at the foot of the sign-in form were unreadable.
Two separate faults sat behind that, and the second was much larger than the
complaint.

**The contrast suite measured the wrong surface.** Every assertion compared text
against `behindCard` — the sky. The footer lines hang below the card's
readability wash and sit over the **planet**, which in daylight is the brightest
thing in the frame. The suite was correct arithmetic applied to the wrong
backdrop, so it passed while the text it was defending was barely legible.
Fixed by modelling `behindFooter` as the worst case — lit cloud, near-white —
and sweeping the footer against it. `footerScrimAlpha` is **square-rooted**: a
linear ramp left a twenty-minute hole either side of sunrise and sunset at
4.2:1, because a planet does not brighten in step with `daylight`. The limb is
fully lit the moment the sun clears the horizon; what the next hour changes is
how much of the disc is lit, not how bright the lit part is.

**The palette was published to a subtree the form was not in.** `<OrbitScene />`
is a **sibling** of `.orbit-form`, and the properties were written onto a div
inside the scene. Custom properties inherit downwards; the form was never
downwards of it. So `--env-card-text`, `--env-card-muted`, `--env-scrim` and the
card's entire readability wash silently resolved to their fallbacks — a fixed
night palette, in broad daylight, for the whole life of the feature.

There was no arithmetic error to find. The numbers were always right; what was
wrong was **who could read them** — and no test that measures the model can see
that. It was found by reading the computed styles out of the running page, which
is the only place the two halves meet.

Published onto `document.documentElement` now, which is an ancestor of both, and
removed again on unmount so a sunset does not outlive the login page and tint
the CRM behind it. `tests/palette-wiring.test.ts` pins the publish target and
asserts every `--env-` name the stylesheet reads has a publisher — a `var()`
with a fallback never errors, so an orphaned name is not a typo to be found
later, it is a value that looks plausible and is wrong forever.

The divider above the footer had the same fixed grey and the same backdrop, and
is now on the same variable and the same wash.

## 32. Clarity, and where the lights in the sea actually came from

Two complaints, one root cause, and one of my own hypotheses killed by
measurement along the way.

**Both were magnification.** Tracing the camera's own rays at 5,500km and a 58°
field: the planet occupies only the bottom fifth of the frame, and at the bottom
edge — its nearest and largest part — an 8K surface renders at **1.4 screen
pixels per texel** on a 4K panel. The shader was stretching each texel across
more than a pixel; there was no more detail in the file to show. The night
texture was worse: 4K against the day's 8K, so **2.8 screen pixels per texel**,
every coastal city smeared three pixels out into the water.

**The sea lights are not in the data.** Measuring the night imagery against a
land mask and a distance transform: 80% of all light over water lies within one
texel of a coast, and light more than 400km offshore is exactly zero. Counting
*perceptible* lit texels after the shader's threshold and gamma, open water
scores **zero both before and after**. The offshore glow was the smear, not the
source — so the fix for it is resolution, and the land-proximity mask described
below is insurance rather than the cure. Worth saying plainly: the mask is not
what fixed the complaint.

**A hypothesis that was wrong.** I expected JPEG ringing around bright coastal
cities to be spilling energy into adjacent water — a plausible mechanism with a
clean story. Measured against a lossless reference it invents light in **36
pixels at quality 82**, which is nothing. Killed in one measurement rather than
becoming an explanation.

**A defect found on the way.** The water mask used `blue - red > k`, which fails
where the ocean is deepest. Blue Marble's abyssal plains are nearly black: the
mid-Atlantic reads (2, 7, 23), blue three times red, difference still only 0.08.
Weighted by latitude that test called **46.1% of Earth land against a true
29.2%** — the deep ocean was classified as land, which is why the mid-Atlantic
sat 430km from "land", and why the deepest ocean got no sun glint. Relative
dominance, `(b - max(r,g)) / b`, removes the brightness dependence and produces
not a tuned constant but a gap: 29.2% land at a cut of 0.12, 30.3% at 0.36,
because almost nothing scores in between. Both the shader and the build script
use 0.22.

**What shipped.** A 16K day tier and an 8K night tier, both genuine downsamples
of the NASA originals, arriving after the scene is already drawing — night
first at 4MB, then the surface at 9.4MB, sequentially. The 16K tier is gated on
window width, `deviceMemory`, connection, and `MAX_TEXTURE_SIZE`, since 16384 is
the common desktop ceiling and an over-limit upload would spend 9.4MB to produce
a black planet. The night texture's unused green channel now carries a
land-proximity field so offshore light can be attenuated rather than deleted —
deleting it would have taken Singapore, Hong Kong, Rio, Helsinki and Chennai,
which the sweep named as the brightest "over water" pixels on Earth.

The threshold moved 0.36 → 0.24, re-derived from the new image's own histogram
(background plateau at 0.208, 99.5th percentile 0.278). Net effect on land:
**1.8× more perceptible lit texels** — cities that read as cities rather than
as amber blobs.

## 33. The sun was a sprite, and the 16K never arrived

Three reports, three genuinely separate causes.

**The lights in the ocean were off Angola.** Mapping the reported frame's pixels
back through the camera to coordinates: the lit water sat at 5–8°S, 11–13°E —
the Cabinda and Congo-mouth oil flares, 108km offshore, and Luanda beside them.
The first land-proximity mask dilated by 60km, which left those flares at 91%
brightness. Measuring instead of guessing gave a startlingly clean split: the
brightest texel of every coastal city that must survive — Singapore, Hong Kong,
Rio, Helsinki, Chennai, Venice, Dubai — is **0 texels from land**, while the
flares are 22 and the Gulf platforms 25. Nothing lies in between.

But tightening the dilation was not enough, and the reason is structural: **the
mask cannot stop bleed at a coastline, by construction.** `night.g` is sampled
with the same bilinear filter as `night.r`, so light spreading a texel into its
own bay carries the mask with it and arrives still reading "land". The mask is
the right tool for a flare a hundred kilometres out and useless against the
thing actually being seen. The second test comes from the DAY texture instead,
whose coastline is crisp and, crucially, independent of where the lights are.
Sweeping it: every city holds full brightness at every suppression up to 1.0,
while the Cabinda flares fall 0.49 → 0.07. Re-rendering the exact reported
frame, the brightest light over water drops **2.26 → 0.26**.

**The sun was a CSS div.** A radial gradient positioned by a custom property and
drawn earlier in the stacking order so the planet would paint over it. That is
why the moment it passed the limb looked cheap, and why no amount of gradient
tuning could have fixed it — a sprite occluded by paint order can only be
clipped. It cannot be dimmed by the air in front of it, cannot redden, cannot
bloom through an atmosphere it knows nothing about, and meets the limb on an
edge belonging to a different renderer with a different idea of where the
horizon is.

Moved into the shader, all of it falls out of arithmetic already running. The
same coverage term that antialiases the silhouette occludes the disc to the same
fraction of a pixel. The same optical depth that makes the sky blue reddens the
sun — scaled by 0.26, which is not a taste control but `sqrt(8500 / 128000)`,
the conversion from this exaggerated 128km scale height back to Earth's real
8.5km. Computing the result across the band the sun actually crosses (the limb
sits 57.5° below horizontal from 5,500km, the atmosphere edge at 47.8°):

| local altitude | transmitted R, G, B | reads as |
| --- | --- | --- |
| −53° | 0.991, 0.980, 0.952 | white |
| −55° | 0.890, 0.763, 0.516 | warm white |
| −56° | 0.647, 0.363, 0.083 | orange |
| −57° | 0.191, 0.021, 0.000 | deep red |
| −58° | — | occluded |

Three degrees of travel, about 120 device pixels, with no keyframe anywhere.
Size is deliberately exaggerated 3.5× — the real sun is 0.266° and would be a
21-pixel dot — chosen because the CSS sun it replaces was 3.4vmax, almost
exactly 1.0° of apparent radius. The composition is unchanged; only the physics
is new. Limb darkening added, because a disc without it reads as a sticker.

**And the 16K tier was never reaching anyone.** Two gates were wrong. It
required `innerWidth >= 1400`, which excluded a 1035px window beside an editor —
a window whose drawing buffer is 2070 × 2290, over four megapixels, and exactly
the case that needs the texture. CSS pixels say how big a window looks; device
pixels say how many samples the shader must fill, which is the only thing
texture resolution answers to.

The second was `connection.effectiveType`, which reported **"3g" for localhost**
with no network involved at all. A coarse estimate was vetoing a download the
machine would have finished instantly. Replaced by measurement: the fetch runs
under an `AbortController` with a 25-second budget and is genuinely cancelled if
it overruns — unlike a timeout wrapped around `Image.src`, which abandons the
request while it goes on consuming a slow connection in the background.
`saveData` is still absolute, because that is a person saying no.

## 34. The atmosphere was a ribbon, and the airglow was the wrong physics

"A blue strip that curves above the earth… it looks fictional." That turned out
to be an exact diagnosis, and measuring it found three separate faults.

**The band was 17x too thick, and its peak was in the wrong place.** From
5,500km the planet's limb subtends 32.46°. A real atmosphere adds 0.57° — 23
device pixels. This shader's 1600km shell added 9.72°, or **384 pixels**. But
thickness was the lesser problem. Computing the limb's radiance profile with the
128km scale height, the band's **brightest point sat 331km above the surface**.
A real atmosphere is brightest where it is densest, which is at the ground.
Putting the peak three hundred kilometres up detaches the glow from the planet,
and that is exactly what makes it read as a ribbon laid over the picture rather
than as air belonging to it.

The shell says where air *can* be; the scale height says where it actually is,
and the second decides the band's shape. Both came down — 500km and 36km,
roughly five times Earth rather than seventeen. The profile now peaks 16 pixels
above the surface and is gone by 80. At golden hour it runs deep orange at the
limb (0.258, 0.035, 0.002), through warm white (0.483, 0.516, 0.389), into blue
(0.216, 0.302, 0.409) — the progression every photograph from orbit shows, and
the one the old settings smeared across 300 pixels until it was flat. At midday
the base now comes out near-white (saturation 0.06) and grades to cyan, instead
of a near-uniform 0.55 from pixel 1 to pixel 100.

Two constants are derived from the scale height and had to move with it: a
grazing path's optical depth goes as its square root, so the transmittance
correction went 0.22 → 0.415 and the solar extinction scale 0.26 → 0.486. A test
now pins the second to `sqrt(8500 / H_RAYLEIGH)` so they cannot drift apart.

**The CSS sky wash was a second, cruder sky.** `.sky-wash` is a full-screen
gradient held at 0.18 — invisible while the shader's own atmosphere was a
384-pixel ribbon, because the ribbon drowned it. Thinning that band to a real arc
left the CSS wash as the brightest blue on screen: a broad diffuse haze filling
the upper frame, attached to nothing. Suppressing it in the browser and
comparing was unambiguous. Same trap as `.horizon-glow` and the dark ring at the
limb, same answer — two renderers with different ideas about the sky cannot both
be right, and once one is computing the answer the other is noise. The ambient
`.sun-glow` and `.moon-glow` went with it, for the same reason: the shader now
produces its own aureole from the same integral, correctly placed.

**And the airglow was modelled as a column when it is a layer.** It was driven
by the total Rayleigh path, which is brightest at the ground — but airglow is
emission from oxygen and hydroxyl in a band around 90km up, and everything below
contributes nothing. The error stayed hidden because the old term *saturated its
own clamp* from the surface out to 200km, producing a flat-topped band that
happened to look like an arc. Thinning the shell removed the padding and the
night limb nearly vanished — which is how the wrong model finally showed itself,
and it was a regression on the one part of this that had been called good.

It is a Gaussian shell now, accumulated in the march that was already walking
the ray. The important consequence is structural: the night limb no longer
shares parameters with the daytime band. They are different physics — emission
against scattering — and can now be got right independently.

**A test of my own that could not fail.** The guard pinning `.sky-wash` to zero
used `opacity:\s*0\b`, which matches `0.18` — the word boundary falls between
the `0` and the dot. It passed against precisely the value it existed to forbid,
and only a mutation caught it. Anchored on the terminator instead.
