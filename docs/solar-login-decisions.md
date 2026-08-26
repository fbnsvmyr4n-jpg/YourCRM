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

## 35. The sun was on screen 0.0% of the day

Moving the discs into the shader in §33 gave them the shader's real camera — 58°
vertical, about 52° horizontal — which is physically correct and made the sun
invisible. Measured over a full day at Cape Town: within the frame's **bearing**
13.9% of the time, within its **altitude** 1.4%, and **never both at once**. The
CSS scene had been hiding that behind a deliberately wide 220° × 70° projection
that folds the whole sky into the frame. Reported simply as "add the sun back
in", which was exactly right.

So the discs are aimed by `aimBody` and the light keeps the physical vector.
`uSunDir` still lights the planet from the true solar direction; only where the
disc is *drawn* is artistic. Two properties survive the remap, and they are the
two that carry the moment:

1. **The limb sits at the same altitude in every direction** — the planet is a
   sphere seen from above the observer, so its edge is at −57.5° whichever way
   the camera faces. Compressing azimuth cannot change when a body crosses it.
2. **Occlusion and reddening come from the pixel, not from the aim.** Whether a
   fragment is in front of the planet, and how much air its ray crossed, are
   properties of that ray.

Altitude maps so real 0° lands exactly on the limb, which is the composition's
premise and what the CSS scene did with `rise = altitude / 70 * horizon`.

**Three further faults found while verifying it.**

*The aureole was gated on `sunVisible`*, which is a ramp across the disc's own
0.27° half-width — so the glow vanished within a frame of the sun touching the
limb. That is backwards: a sun just below the edge throws an enormous halo
around it, and that glow **is** the orbital sunset. Cutting it at the moment of
contact is exactly what makes the crossing read as an object being switched off.
Driven by `sunIntensity` now, which ramps from 12° below the horizon to 6° above,
so the halo swells, reddens and fades over minutes.

*A sun behind the camera painted a second sun.* The refraction flattening
divides the offset by `max(alongSun, 0.05)`; for a ray pointing directly away
from the sun both offset components are zero, so the angle evaluates to zero,
passes the radius test, and draws an anti-sun at the antipode — whenever the sun
is behind the viewer, which on this camera is most of the day. Now gated on
`alongSun > 0.0`, and pinned by a test, because the mutation showed nothing
covered it.

*And I had the camera bearing wrong in my own analysis.* I hand-computed the
facing as 180° from raw SunCalc and concluded the sun was rendering on the wrong
side. Reading `uYaw` back out of the live GL context gave 0. The renderer was
right and the check was wrong — which is the same failure mode as every other
one in this document, and the reason for reading uniforms back rather than
reasoning about them.

**Refraction flattening** was added at the same time, and it is the detail that
separates a sun seen *through* an atmosphere from one sliding behind an edge.
Light from a body at the limb crosses the air tangentially and its lower edge is
bent more than its upper, so the disc squashes — to 0.62 of its height at
contact. It is why every photograph of a sunrise from the ISS shows an orange
ellipse rather than a circle, and it is what "a sun moving behind a 2D object"
was describing the absence of.

## 36. Two bugs that made the sun a sticker on the limb

Reported as "the sun is only visible in the hemisphere band". That is an exact
description of the first bug, and chasing it uncovered a second and larger one.

**Alpha carried no body.** The last line of the fragment shader computes
`coverage` — the alpha channel, meaning "is there anything at this pixel" — from
scattering and ground coverage only. The sun disc added to `colour` and
contributed **nothing to coverage**. Above the atmosphere, where the sun spends
most of its arc, `scattered` is ~0, so alpha was ~0 and the `SRC_ALPHA` blend
multiplied the disc straight out of existence. It was being drawn correctly
across the entire sky and erased everywhere except the one place the air made
the frame opaque — the band around the limb. Fixed by giving the bodies their
own `bodyAlpha` and folding it into the coverage max.

**And every alpha in the scene was being squared.** `blendFunc(SRC_ALPHA,
ONE_MINUS_SRC_ALPHA)` applies those factors to the alpha channel as well as to
colour, so over a cleared buffer the stored alpha is

    A = A_src * A_src + 0 * (1 - A_src) = A_src²

A band asked to be 18% opaque was written at 3%, and because the error grows as
things get fainter it struck precisely the soft edges that matter: the sun's
aureole, the outer atmosphere, the airglow arc. The same squaring, from the
other direction, once made the entire star field invisible.

It survived because the state was **set** in one place and **restored by hand**
in another: the star pass ended with its own literal
`blendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA)`, and since that pass runs every
frame, the planet had never once drawn with the intended blend. Setting
`blendFuncSeparate` in `create()` therefore changed nothing at all, which is
what made it confusing. One `sceneBlend()` function now, called from both.

**The method that found it.** None of this was reasoned out. The automation
browser has no `preserveDrawingBuffer`, which had made pixel evidence impossible
all through this project — but dispatching `visibilitychange` forces the clock
to snap and publish, the canvas redraws **synchronously** inside that dispatch,
and `readPixels` in the same task reads the frame before it is presented. With
that, the sun's halo could be fitted against the formula that produced it: the
measured profile matched the SQUARE of the prediction across four decades of
offset, which does not happen by chance. Replacing the halo term with a constant
0.5 and reading back 64/255 = 0.251 settled it.

Afterwards the halo matches its formula across the whole range — 74 against 83
at two disc radii, then 42/45, 24/25, 14/15, 9/9 out to twelve. Before the fixes
it died by three radii, which is why it read as a flat disc rather than a light.

**A hypothesis I got wrong on the way.** I first blamed variable shadowing: the
aureole declared `float near` inside a block where the scattering march had
already declared `near` and `far` at function scope. Plausible, and wrong —
renaming changed nothing. Worth doing anyway, but it was not the cause.

## 37. The arc, solved in the space the requirement lives in

The sun's path was sketched over a screenshot: up one edge of the frame, across
the top, down the other. Reading points off it against the viewport gives a
half-width of about 0.44 and an apex around y = 0.20.

Two attempts at this failed, both for the same reason, and the second failure is
the interesting one.

**Scaling azimuth by a constant cannot work.** The first version reused the CSS
scene's 220° field and produced an arc spanning x 0.27 to 0.73 — the middle half
of the screen, which is exactly where the sign-in card is. Solving for the
constant that puts the limb crossings at x 0.05 and 0.95 gave 106, and that
framed the equinox correctly. Then midsummer: **ten hours off the side of the
screen.** A body's screen x depends on its ALTITUDE as well as its bearing, and
at Cape Town azimuth swings ±115° in December against the equinox's ±89°. Every
constant that framed one season lost another. Bounding an angle does not bound a
position.

**So the aim is specified in screen space and the azimuth is solved for it.**
Pick the x the arc should pass through — a `tanh` that cannot exceed
ARC_HALF_WIDTH by construction — then bisect on azimuth until the projection
lands there. Screen x is monotonic in bearing across the half-turn either side
of the camera, so it converges in a few steps, and it runs once per body per
frame rather than per pixel. The result is bounded in every season at every
latitude with no constant left to be wrong.

Altitude gets the same treatment for the same reason. A linear map cannot both
put the equinox apex on the reference (34.8° of rise) and keep midsummer's 79.5°
sun inside the frame (28.3° allowed). An exponential approach reaches the frame
top only in the limit, so nothing can overshoot, while still rising fast enough
near the horizon to hit the reference apex.

Measured across the year, with zero minutes off-frame in every season:

| | x range | apex | sun up |
| --- | --- | --- | --- |
| sketch | 0.09 – 0.97 | 0.20 | |
| equinox | 0.107 – 0.893 | 0.201 | 12.0h |
| midsummer | 0.079 – 0.921 | 0.114 | 14.3h |
| midwinter | 0.167 – 0.831 | 0.350 | 9.8h |

Confirmed in the browser by reading `uSunDisplayDir` back out of the live GL
context, projecting it, and sampling that exact pixel: a full-brightness opaque
disc at Sunrise (0.892, 0.908), Morning (0.885, 0.761), Day (0.455, 0.202) and
Golden hour (0.108, 0.913), and correctly occluded at Sunset.

Two properties still survive the artistic placement, and they remain the reason
it is defensible: the planet's edge is at the same altitude in every direction,
so nothing horizontal changes when a body crosses it; and occlusion and
reddening are computed from each pixel's own ray, not from the aim.

**A test of mine that measured nothing.** Fitting the spread by "distance to the
nearest point on the sketched line" returned the same 0.21 error for every
candidate from 106 to 150 — it was measuring the gaps between my sampled
reference points, not the fit. Replaced by the features that actually matter:
half-width, apex, and minutes spent off the edge of the frame.

## 38. Why the sun could not be fixed by fixing the sun

Reported as "a white ball in the stars". The obvious reading is that the disc
needs internal detail — limb darkening, colour, structure. That was tried and
measured, and it cannot work.

**The tone curve eats everything inside a bright disc.** With a peak of 26 in
linear light, `c / (c + 1)` followed by gamma maps the centre of the disc to 250
and its rim — already dimmed to 35% — to 243. A 3% change across the whole face.
Pushing limb darkening further and adding a warm rim colour moved the numbers to
252 at the centre and 249 at nine-tenths of the radius: still flat. Ratios
between channels survive compression no better than absolute levels do once
everything is above about 5, where the curve has no slope left.

And a blown-out disc is *correct*. A camera pointed at the sun clips; a sun that
did not would not read as the sun. So the disc is not the problem to solve.

**The character has to live around the light, not inside it.** Three changes,
all measured by reading the framebuffer back:

- The inner corona roughly doubled, so the disc melts into a glow instead of
  ending on an edge: alpha at 1.5 disc radii went 74 → 143, and 89 at two radii.
- The halo now runs **warm near, cool far** — neutral forward-scattered Mie
  close in, blue Rayleigh beyond — because a single warm tint across the whole
  glow is the tell of a hand-drawn lens flare.
- **Six diffraction spikes**, which is what finally stopped it reading as a
  pasted circle. Measured at three disc radii: 91 at a spike against 53 between
  them. The star field already draws spikes for the same physical reason, so the
  sun and the stars now behave as though recorded by the same instrument — which
  is most of what "photographic" means.

The warm rim was kept even though it is nearly invisible at noon, because it is
not invisible at sunset: there `slant` has already pulled the disc down to a few
units of linear light, where the tone curve has slope again, and the same
gradient shows properly.

## 39. The moon, with its real phase

`illuminatedFraction` was already being computed and thrown away — the moon was
drawn as a flat lit disc at every phase.

It is a sphere now. The phase angle comes from the real fraction
(`f = (1 + cos θ)/2`, so `θ = acos(2f − 1)`), and a point on the disc is lit
when its own surface normal faces the sun: `u·sin θ + w·cos θ > 0`, with
`w = sqrt(1 − u² − v²)`. That is what curves the terminator into the ellipse a
real moon shows. A half-plane cut is the tempting simplification and it looks
correct at exactly two phases in the month.

**The lit side faces the sun that is on screen**, taken from `uSunDisplayDir`
rather than the physical vector. Both bodies are in the same frame, and the one
thing anyone will actually check is whether the crescent points at the sun they
can see; the physical vector would light it from a direction the frame does not
contain. The fraction stays real either way, and so does which side is lit,
because the artistic remap preserves the bodies' left-right order.

Earthshine was added with it — the ashen glow on the dark limb of a young moon,
sunlight bounced off the Earth. It is strongest exactly when the crescent is
thinnest, because that is when the Earth seen from the moon is nearly full.

Verified by rendering and counting lit pixels rather than by reading the code:

| date | true illumination | measured lit fraction of the disc |
| --- | --- | --- |
| 2026-03-03 | 0.998 | 1.00 |
| 2026-03-27 | 0.725 | 0.77 |
| 2026-03-25 | 0.509 | 0.54 |

The small excess is the softened terminator and earthshine crossing the
brightness threshold, which is what those are for.

## 40. One angle doing two jobs

Reported as the sun stretching too much as it passed behind the atmosphere and
the planet. The refraction flattening was real and wanted; the way it was
applied was not.

**A single flattened angle fed everything.** `sunAngle` was computed from an
offset whose vertical component had already been divided by the flattening
factor, and that one number then drove the disc, the corona, and all six
diffraction spikes. At the limb the whole glow — not just the sun — stretched
horizontally by up to 27%.

The distinction that fixes it is physical rather than aesthetic. Refraction
bends light passing through **air**, so it distorts the sun's own image. The
aureole and the spikes are not the sun's image: they are what the **instrument**
does with a bright source — scattering inside the optics, and light bending
around an aperture. A lens does not become elliptical because the thing it is
looking at is near the horizon. So there are two angles now, and a test asserts
that the round one is not quietly rebuilt from the flattened offset.

**Two magnitudes were also wrong.**

The squash was 0.62, nearly twice the real figure. A sun on the horizon loses
about a fifth of its height to refraction, so it is 0.82 now — an ellipse rather
than a smear.

And it ramped over ±6° of altitude, which at this latitude is roughly eighty
minutes either side of the horizon. The sun spent all of it visibly squashed,
which reads as the shape the sun simply *has* rather than as something
happening. Refraction only bends the image appreciably in the last degree or two,
so the ramp is ±2.5° now. Measured through an actual sunset, the flattening
window went from about 160 minutes to about 20:

| UTC | limb proximity |
| --- | --- |
| 16:35 | 0.00 |
| 16:45 | 0.16 |
| 16:55 | **0.92** |
| 17:05 | 0.25 |
| 17:15 | 0.00 |

## 41. The moon gets a surface

It was a tinted circle with a correct phase — the shape of the terminator was
right and there was nothing inside it.

**It samples NASA's LRO/LROC albedo map now.** 86kB for a 1024 × 512 near side,
which is already finer than the disc can resolve: the moon renders about fifty
pixels across, so one texel is smaller than a rendered pixel. Validated against
known features rather than by eye — Mare Tranquillitatis 65, Oceanus Procellarum
69, southern highlands 161, far side 177, and Tycho brightest at 220 with its
fresh rays.

The disc point already gives a surface normal, so it maps straight onto lunar
coordinates. The moon is tidally locked, so a fixed equirectangular map is
correct and libration's ±8° is under half a pixel here.

**Rotated by the parallactic angle**, which is the difference between drawing a
moon and drawing *the* moon. It is the angle between the observer's zenith and
the moon's north pole: on the same night, −33° from London and −143° from Cape
Town. That is why the moon looks upside down when you fly between hemispheres,
and without it the maria sit in one fixed orientation that is wrong everywhere
but one latitude. SunCalc returns it already; it was simply being discarded.
Guarded against NaN, which the angle formally is at the zenith — a NaN there
would make the rotation NaN and the moon vanish, silently, only for observers
directly beneath it.

**And the same tone-curve trap as the sun.** The map holds a real 2:1 ratio
between maria and highlands, and the first render came out 149 to 181 — 1.2:1, a
faint smudge. At a peak near 1.0 in linear light the curve has already lost most
of its slope. Fixed by boosting the albedo's own contrast and rendering the moon
LOWER on the curve rather than brighter: 117 to 169 now, a ratio of 1.44 with
the standard deviation across the disc up from 12 to 17. A slightly dimmer moon
that clearly has a face beats a brighter one that is a disc.

A faint halo was added outside the disc as well, scaled by the phase because a
crescent throws almost no light. Without it the moon met the sky on a cut edge —
it sat *on* the frame rather than in it, which was most of what read as "a basic
circle".
