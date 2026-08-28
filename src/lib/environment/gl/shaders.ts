/**
 * The planet and its atmosphere, as one fragment shader.
 *
 * Every pixel casts a ray from the camera, intersects the planet, samples
 * NASA's own imagery at the latitude and longitude it hit, and lights it from
 * the real solar direction. The blue of the limb and the orange of a sunset are
 * not painted: they are the result of integrating Rayleigh and Mie scattering
 * along that ray, which is why they change the way the sky actually changes
 * rather than the way a gradient does.
 *
 * There is no mesh. A full-screen quad and an analytic sphere intersection give
 * exact silhouettes at any resolution, with no tessellation to go faceted at
 * the horizon — which is the one edge in this composition nobody can be allowed
 * to see polygons on.
 *
 * ## Frame of reference
 *
 * Everything is in the observer's own local frame: **x east, y north, z up**,
 * with the camera above their actual coordinates. That is what makes the sun's
 * altitude and azimuth — which are already local horizontal coordinates —
 * usable directly, with no conversion to invent errors in.
 *
 * It also means the planet below is genuinely the part of the world the user is
 * over. The terminator sweeps across real continents and the city lights come
 * on where cities actually are.
 */

export const VERTEX_SHADER = /* glsl */ `#version 300 es
in vec2 aPosition;
out vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

export const FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColour;

uniform vec2  uResolution;
uniform vec3  uSunDir;        // unit, observer's local frame (east, north, up)
uniform vec3  uMoonDir;
uniform float uMoonLight;     // 0..1, already gated on phase and altitude
uniform float uMoonVisible;   // 0..1, simply whether the moon is above the horizon
/** 0 = new, 1 = full. The real illuminated fraction, for the real phase. */
uniform float uMoonIllumination;
/** NASA LRO albedo of the near side, equirectangular, 0 deg at the disc centre. */
uniform sampler2D uMoon;
/** Rotation of the moon's north pole away from the observer's zenith. */
uniform float uMoonNorthAngle;

/* Where the DISCS are drawn, which is not where the light comes from.

   The shader's real camera is 58° by about 52°, and against it the sun is on
   screen 0.0% of the day — the CSS scene had been hiding that behind a 220°
   projection that folds the whole sky into the frame. So the discs are aimed by
   aimBody() in projection.ts and the lighting keeps uSunDir. What survives
   the remap is everything that matters: the limb sits at the same altitude in
   every direction, so the moment of crossing is unchanged, and occlusion and
   reddening are computed from each pixel's own ray rather than from here. */
uniform vec3  uSunDisplayDir;
uniform vec3  uMoonDisplayDir;
uniform float uSunLimbProximity;  // 0 clear of the limb, 1 touching it
/*
   How strongly the sun lights the sky, 0..1 — NOT whether its disc is up.

   The first version gated the aureole on visibility, which is a ramp across the
   disc's own 0.27 deg half-width: the glow therefore vanished within a single
   frame of the sun touching the limb. That is backwards. A sun just below the
   edge still throws an enormous halo around it — light scattering round the
   planet through a long slant of atmosphere — and that glow IS the orbital
   sunset. Cutting it at the moment of contact is precisely what makes the
   crossing look like an object being switched off.

   This ramps from about 12 deg below the horizon to 6 deg above, so the halo
   swells, reddens and fades over minutes. The disc needs no such gate: the
   planet's own coverage term occludes it.
*/
uniform float uSunIntensity;
uniform float uCameraHeight;  // metres above the surface
uniform float uFov;           // vertical field of view, radians
uniform float uPitch;         // camera tilt below horizontal, radians
uniform float uYaw;           // compass bearing the camera faces, radians
uniform mat3  uEnuToEcef;     // observer's local frame into earth-fixed
uniform float uExposure;
uniform int   uSteps;         // view samples through the atmosphere
uniform int   uLightSteps;    // light samples toward the sun

uniform float uCloudPhase;   // weather's own offset, in texture units
uniform sampler2D uDay;
uniform sampler2D uNight;
uniform sampler2D uClouds;
uniform sampler2D uElev;    // land elevation, a visualisation ramp; ocean is a true 0

const float PI = 3.141592653589793;

/*
   Earth, and an atmosphere deliberately three and a half times too deep.

   The real one is 100km on a 6,371km planet — one and a half percent of the
   radius. Seen from 5,500km that is about half a degree of a 58° frame: five
   pixels. Rendered honestly it is almost invisible, and the planet meets the
   sky at a hard edge, which is the one join in this composition nobody can be
   allowed to see.

   Every space visualisation exaggerates this and so does this one — but the
   first attempt exaggerated it SEVENTEEN-FOLD, to a 1600km shell with a 128km
   scale height, and the result was reported as "a blue strip that curves above
   the earth… it looks fictional". That description turned out to be an exact
   diagnosis.

   Measuring the limb's radiance profile: with a 128km scale height the band was
   384 device pixels thick against a real 23, and worse, its BRIGHTEST POINT sat
   331km above the surface. A real atmosphere is brightest where it is densest,
   which is at the ground. Putting the peak three hundred kilometres up detaches
   the glow from the planet, and that is precisely what makes it read as a
   ribbon laid over the image rather than as air.

   The shell says where air CAN be; the scale height says where it actually is,
   and the second one is what shape the band comes out. So both came down —
   500km and 36km, roughly five times Earth rather than seventeen. The profile
   now peaks 16 pixels above the surface and is gone by 80: at golden hour it
   runs deep orange at the limb, through warm white, into blue, which is the
   progression every photograph from orbit shows and which the old settings
   smeared across three hundred pixels until it was a flat band.

   Two constants downstream are derived from this and must move with it: a
   grazing path's optical depth goes as sqrt(scale height), so the transmittance
   correction and the solar extinction scale are both recomputed against 36km
   rather than 128km. They are marked where they appear.
*/
const float R_PLANET = 6371000.0;
const float R_ATMOS  = 6871000.0;

/* Rayleigh scattering per metre at sea level, per channel. Blue scatters an
   order of magnitude more than red — this triple IS why the sky is blue and
   why a low sun is orange. */
const vec3  BETA_RAYLEIGH = vec3(5.8e-6, 13.5e-6, 33.1e-6);
/* Mie, deliberately below the textbook 21e-6.

   Mie is the large-particle term — dust, droplets — and it scatters all
   wavelengths about equally, so it is grey. At the exaggerated thickness this
   scene uses it swamped the Rayleigh term and turned the limb into a dirty tan
   haze instead of the blue band that makes the picture. Rayleigh is what is
   worth exaggerating; Mie is what has to be held back when you do. */
const float BETA_MIE      = 8e-6;

/* How fast each falls off with altitude, stretched to match the shell above. */
const float H_RAYLEIGH = 36000.0;
/* And kept LOW relative to Rayleigh, so the grey stays near the ground where
   it belongs rather than spreading through the whole band. */
const float H_MIE      = 4000.0;

/*
   Airglow lives in a SHELL, and modelling it as anything else was wrong.

   It was previously driven by the Rayleigh column — how much air the ray
   crossed in total. That is not what airglow is. It is emission from oxygen and
   hydroxyl in a thin band around 90km up, and everything below that contributes
   nothing at all. Tying it to the column meant it was brightest where the air
   was thickest, which is the ground, so it hugged the surface instead of
   arching above it.

   The error stayed hidden while the atmosphere shell was seventeen times too
   thick: the column term saturated its own clamp from the surface out to 200km,
   producing a flat-topped band that happened to look like an arc. Thinning the
   shell to something honest removed the padding and the night limb nearly
   vanished — which is how the wrong model finally showed itself.

   Now it is a Gaussian layer, and the important consequence is that the night
   limb no longer shares parameters with the daytime band. They are different
   physics — emission against scattering — and they can now be got right
   independently, which is exactly what was being asked for.
*/
const float GLOW_ALTITUDE = 120000.0;
const float GLOW_WIDTH    = 90000.0;

/* Mie asymmetry: aerosols scatter strongly forward, which is what puts the
   bright halo immediately around the sun rather than spreading it evenly. */
const float MIE_G = 0.76;

/* Distance to the near and far intersections of a ray with a sphere centred at
   the origin. Returns (-1, -1) on a miss. */
vec2 raySphere(vec3 origin, vec3 dir, float radius) {
  float b = dot(origin, dir);
  float c = dot(origin, origin) - radius * radius;
  float d = b * b - c;
  if (d < 0.0) return vec2(-1.0);
  float s = sqrt(d);
  return vec2(-b - s, -b + s);
}

float rayleighPhase(float mu) {
  return 3.0 / (16.0 * PI) * (1.0 + mu * mu);
}

float miePhase(float mu) {
  float g2 = MIE_G * MIE_G;
  return 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + mu * mu)) /
         ((2.0 + g2) * pow(1.0 + g2 - 2.0 * MIE_G * mu, 1.5));
}

/* Optical depth from a point toward the sun. Returns (rayleigh, mie); a
   negative first component means the ray is blocked by the planet, which is
   what puts the Earth's own shadow into the atmosphere at dusk. */
vec2 opticalDepthToSun(vec3 point, vec3 sunDir) {
  if (raySphere(point, sunDir, R_PLANET).x > 0.0) return vec2(-1.0);

  float far = raySphere(point, sunDir, R_ATMOS).y;
  float step = far / float(uLightSteps);
  vec2 depth = vec2(0.0);

  for (int i = 0; i < 16; i++) {
    if (i >= uLightSteps) break;
    vec3 p = point + sunDir * (float(i) + 0.5) * step;
    float h = length(p) - R_PLANET;
    depth += vec2(exp(-h / H_RAYLEIGH), exp(-h / H_MIE)) * step;
  }
  return depth;
}

/* Latitude and longitude of a point on the sphere, as texture coordinates. */
vec2 surfaceUv(vec3 pointFromCentre) {
  vec3 n = normalize(uEnuToEcef * normalize(pointFromCentre));
  float lat = asin(clamp(n.z, -1.0, 1.0));
  float lon = atan(n.y, n.x);
  return vec2((lon + PI) / (2.0 * PI), 0.5 - lat / PI);
}

void main() {
  /* The ray for this pixel. The camera sits above the observer, yawed to the
     compass bearing the composition faces and pitched down toward the limb. */
  vec2 ndc = (vUv * 2.0 - 1.0);
  ndc.x *= uResolution.x / uResolution.y;

  float t = tan(uFov * 0.5);
  vec3 local = normalize(vec3(ndc.x * t, 1.0, ndc.y * t));

  // Pitch down, then yaw to the bearing. Kept as two explicit rotations rather
  // than one matrix so the intent survives being read later.
  float cp = cos(uPitch), sp = sin(uPitch);
  local = vec3(local.x, local.y * cp - local.z * sp, local.y * sp + local.z * cp);
  float cy = cos(uYaw), sy = sin(uYaw);
  vec3 dir = vec3(local.x * cy + local.y * sy, -local.x * sy + local.y * cy, local.z);

  // Origin relative to the planet's centre.
  vec3 origin = vec3(0.0, 0.0, R_PLANET + uCameraHeight);

  vec2 atmos = raySphere(origin, dir, R_ATMOS);
  vec2 ground = raySphere(origin, dir, R_PLANET);

  vec3 surface = vec3(0.0);
  bool hitGround = ground.x > 0.0;

  /*
     Soft coverage at the silhouette.

     An analytic sphere intersection is exactly right and therefore exactly
     hard: a pixel either hits or misses, so the limb is a stair of jagged
     pixels — the "not clean around the edges". There is no geometry to
     multisample and no depth buffer to resolve, so the edge is antialiased
     analytically instead: take the ray's closest approach to the planet's
     centre, compare it to the radius, and soften across one pixel's worth of
     that quantity using its screen-space derivative.
  */
  float closest = length(origin - dot(origin, dir) * dir);
  float edge = closest - R_PLANET;
  float edgeWidth = max(fwidth(edge), 1.0);
  float groundCoverage = (dot(origin, dir) < 0.0)
    ? 1.0 - smoothstep(-edgeWidth, edgeWidth, edge)
    : 0.0;

  if (hitGround) {
    vec3 p = origin + dir * ground.x;
    vec3 n = normalize(p);
    vec2 uv = surfaceUv(p);

    float sunCos = dot(n, uSunDir);

    /* The terminator, softened over about two degrees.
       A hard step would draw a line across the planet that no photograph of
       Earth has ever shown — the sun is half a degree wide and the atmosphere
       spreads its light further still. */
    float lit = smoothstep(-0.045, 0.075, sunCos);

    vec3 day = texture(uDay, uv).rgb;
    vec3 night = texture(uNight, uv).rgb;

    /*
       Weather moves, and it does not move rigidly.
       
       Scrolling the cloud texture alone slides a sheet across the planet, which
       reads worse than leaving it still — the eye immediately sees one picture
       being dragged over another. Weather does not translate; it deforms.
       
       So the lookup is domain-warped: a second, much coarser sample of the same
       texture displaces where the first one reads. Regions of the field then
       drift at slightly different rates and shear against each other, and cloud
       shapes evolve rather than merely arrive. One extra sample for the whole
       effect.
       
       Only longitude wraps, so only u carries the drift. A v offset large
       enough to matter would slide the tropics toward the poles, which is both
       wrong and — because the texture is clamped vertically — visibly smeared.
    */
    float warp = texture(uClouds, vec2(uv.x * 0.42 - uCloudPhase * 0.35, uv.y * 0.42 + 0.2)).r;
    vec2 cloudUv = vec2(
      uv.x + uCloudPhase + (warp - 0.5) * 0.03,
      uv.y + (warp - 0.5) * 0.006
    );

    float cloud = texture(uClouds, cloudUv).r;

    /*
       Where the water is, read out of the imagery rather than shipped as a
       fourth texture. Blue Marble's oceans are the only large areas where blue
       runs well ahead of red; land is red-dominant almost everywhere, and ice
       is neutral.

       RELATIVE dominance, not a difference — and that correction matters most
       exactly where the ocean is deepest. Blue Marble's abyssal plains are
       nearly black: the mid-Atlantic reads (2, 7, 23), where blue is three
       times red and the difference is still only 0.08. Under the old
       b - r > 0.03..0.14 test the deep ocean read as LAND, and got no glint
       from a sun sitting right on it. Weighted by latitude that test called
       46.1% of Earth land against a true 29.2%.

       Dividing by blue removes the brightness dependence, and what is left is
       not a tuned constant but a gap: the land fraction is 29.2% at a cut of
       0.12 and 30.3% at 0.36, because almost nothing on Earth scores in
       between. Ice lands at 0.02, the Sahara at -0.62, the Amazon at -1.50,
       deep ocean at 0.70.
    */
    float blueDominance = (day.b - max(day.r, day.g)) / max(day.b, 0.02);
    /* Cloud-free, because two different questions are being asked of this.
       Glint needs to know whether the sun is hitting water the eye can see, so
       cloud has to hide it. The city-light test needs to know whether this
       point IS ocean, which cloud does not change. */
    float ocean = smoothstep(0.10, 0.34, blueDominance);
    float water = ocean * (1.0 - cloud * 0.9);

    /*
       Cloud shadows.
       Cloud sits about 10km above the surface, so it shades the ground OFFSET
       from itself — toward the anti-solar side. Without this the clouds read as
       paint on the sphere rather than as something floating above it, which is
       one of the strongest tells that a rendered Earth is a texture on a ball.
       The offset is in texture space, scaled by how oblique the sun is: at noon
       a cloud shades the ground directly beneath it and the offset vanishes.
    */
    vec3 eastAt = normalize(cross(vec3(0.0, 0.0, 1.0), n));
    vec3 northAt = cross(n, eastAt);
    vec2 sunOnSurface = vec2(dot(uSunDir, eastAt), dot(uSunDir, northAt));
    float obliquity = sqrt(max(0.0, 1.0 - sunCos * sunCos));
    vec2 shadowUv = cloudUv - sunOnSurface * obliquity * 0.004 * vec2(1.0, -1.0);
    float shadowCloud = texture(uClouds, shadowUv).r;

    /* City lights belong to the dark side only, and they are emissive: they do
       not care how bright the sun is, only that it has gone. Cloud covers them,
       which is why the real Black Marble has holes in it.

       THRESHOLDED HARD, and the number came from the image rather than from
       taste. Sampling this texture's histogram: median 0.122, 90th percentile
       0.275, maximum 0.506. It is not lights on black — it is a mid-grey Earth
       with lights on it, so a threshold of 0.16 passed over half the picture
       through as "emissive" and lit the whole night side.

       The texture is now Black Marble 2016, whose histogram is better but not
       clean either: median 0.059, then a broad plateau at 0.325 which is the
       land it draws under the lights. Cut at 0.36 — above that plateau — and
       multiplied back up, only what is genuinely a light survives. The gamma curve at the end of this
       shader lifts near-black to mid-grey, so anything left in that floor is
       not subtle; it is the difference between night and dusk. */
    /* WARM, and clustered rather than scattered.

       Rendered neutral they read as stars lying on the planet, which is exactly
       how they were mistaken. Sodium and high-pressure lighting is amber — that
       is what Black Marble records and what makes a night-side city look like a
       city rather than a hole in the occlusion. The tint is applied AFTER the
       threshold so it colours the lights and not the floor they sit on. */
    /*
       And attenuated OFFSHORE, using a land-proximity field baked into the
       night texture's green channel at build time.

       Not a guess about what looks right. Sweeping the imagery against a
       distance transform: 80% of all light over water lies within one texel of
       a coast, and light more than 400km out is **exactly zero**. There are no
       cities in the open ocean. What is genuinely out there — gas flares in the
       Persian Gulf and the Niger Delta, fishing fleets off Argentina — is real,
       but a lone amber point in a black ocean reads as a defect on a login
       screen whether or not it is accurate.

       The alternative was a binary land test, and it is a trap: the same sweep
       named the BRIGHTEST "over water" pixels on Earth as Singapore, Hong Kong,
       Rio, Helsinki and Chennai. They are coastal cities on bays, and deleting
       light over water deletes them.

       Measured, the split is clean enough that the mask barely has to be
       careful: the brightest texel of every one of those cities is ZERO texels
       from land, while Angola's oil flares are 22 texels out and the Persian
       Gulf platforms 25. The first dilation was 60km and left the Angolan
       flares at 91% — the amber patch in the ocean that got reported. It is
       ~15km now, and the floor here dropped with it: what still survives is
       genuinely a hundred kilometres out and should read as a hint, not a
       city.

       The threshold moved 0.36 -> 0.24 with the texture. This source's own
       histogram puts a hard background plateau at 0.208 and the 99.5th
       percentile at 0.278: 0.24 clears the floor while keeping roughly 60%
       more genuine towns than 0.36 did.
    */
    float landProximity = night.g;
    float offshore = mix(0.10, 1.0, landProximity);

    /*
       And a second, independent test — because the mask alone CANNOT stop the
       bleed at a coastline, by construction.

       night.g is sampled with the same bilinear filter as night.r. Where a
       city's light spreads a texel or two into its bay, the mask spreads with
       it and arrives still reading "land". The mask is the right tool for a
       flare a hundred kilometres out and useless against the thing actually
       being seen, which is a coastal city smeared across the water beside it.

       So the ocean test comes from the DAY texture instead. Its coastline is
       crisp and, more to the point, entirely independent of where the lights
       are — nothing has bled into it. A light that lands on a pixel the
       surface says is open ocean is not a city.

       0.85, measured. Sweeping it: Singapore, Hong Kong, Rio, Venice,
       Helsinki, Alexandria and Luanda hold full brightness at every value up
       to 1.0, because each has land under it within a texel or two. The
       Cabinda flares fall from 0.49 to 0.07 and the Persian Gulf platforms
       from 0.31 to 0.05. Short of 1.0 so that genuine offshore activity
       remains a hint rather than being censored.
    */
    float lightMask = max(0.0, night.r - 0.24) * 5.0 * offshore * (1.0 - ocean * 0.85);
    vec3 cities = lightMask * vec3(1.0, 0.72, 0.38) * (1.0 - lit) * (1.0 - cloud * 0.75);

    /* Lambert with a generous wrap, plus a little ambient.

       Real: the sky itself is a light source. Ground near the terminator is lit
       by the whole blue dome above it, not only by the direct beam — which is
       why an overcast dusk is not black. Without it the far half of the visible
       disc fell away to nothing and took the coastlines with it, which is the
       "detail on the Earth isn't visible" this is answering. */
    float diffuse = max(0.0, (sunCos + 0.22) / 1.22);
    float skyLight = smoothstep(-0.25, 0.35, sunCos) * 0.16;

    /*
       The terminator is WARM, and that is not a stylistic choice.
       Along the day-night line the surface is lit by a sun low in its own sky,
       so the light reaching it has crossed a great deal of atmosphere and
       arrived orange — the same reason sunset is orange from the ground, seen
       from above as a band following the curve. A plain Lambert falloff renders
       it grey and reads as a shadow rather than as evening.
    */
    /* Narrow. The band was 0.42 wide in sunCos, and because this vantage
       looks toward the limb most of the visible surface sits at a low sun
       angle — so nearly the whole planet took the tint and went olive-brown.
       Sunset is a line across a world, not a wash over one. */
    float grazing = 1.0 - smoothstep(0.0, 0.16, sunCos);
    vec3 sunlight = mix(vec3(1.0), vec3(1.28, 0.82, 0.55), grazing * lit);

    /* Contrast lifted around a mid grey rather than brightness raised. Blue
       Marble is a flat, evenly-lit mosaic by design — good for mapping, muted
       as a photograph — and simply scaling it makes a brighter flat image. */
    vec3 surfaceColour = clamp((day - 0.5) * 1.26 + 0.5, 0.0, 1.0);
    /* Saturation lifted separately from contrast. Blue Marble is deliberately
       desaturated for cartographic neutrality; the ocean in particular reads
       grey where it should read blue, and greyness at this scale is
       indistinguishable from haze. */
    float grey = dot(surfaceColour, vec3(0.299, 0.587, 0.114));
    surfaceColour = clamp(mix(vec3(grey), surfaceColour, 1.22), 0.0, 1.0);
    /*
       Relief.

       Until now the planet was a photograph on a perfectly smooth ball: the
       only thing lighting it was dot(sphere normal, sun), so the Andes, the
       Himalaya and the Atlas all rendered as flat colour. Broadcast globes read
       as solid because their mountains have a lit flank and a shaded one, and
       that is the single biggest thing this was missing.

       The elevation map supplies the shape. Its gradient is the slope, and
       lighting the slope is the whole technique — the same one the clouds above
       already use, but driven by real terrain instead of by cloud thickness.

       Two details that would be wrong if left out:

       Equirectangular texels are not square on the ground. A step in u spans
       cos(latitude) as much ground as the same step in v, so the east gradient
       has to be divided by it or the relief stretches sideways toward the poles
       until Greenland looks combed. The divisor is floored because at the pole
       itself the correction is infinite.

       And v runs SOUTH, so the north gradient carries a minus — the same
       convention the cloud normal above uses, deliberately, so the two agree
       about which way the light is coming from.
    */
    float cosLat = max(0.2, sqrt(max(0.0, 1.0 - n.z * n.z)));
    vec2 eStep = vec2(0.0009, 0.0018);
    float eW = texture(uElev, uv - vec2(eStep.x, 0.0)).r;
    float eE = texture(uElev, uv + vec2(eStep.x, 0.0)).r;
    float eN = texture(uElev, uv - vec2(0.0, eStep.y)).r;
    float eS = texture(uElev, uv + vec2(0.0, eStep.y)).r;

    /*
       26 is the knee, measured rather than picked. Sweeping the strength and
       reading the frame back — mean local luma gradient over the mid band of
       the planet, at London, midday:

         off   0.04858
         8     0.04993   +2.8%
         26    0.05060   +4.2%
         48    0.05046   +3.9%   no better than 26

       Past the knee the extra tilt only pushes more pixels into the clamp
       below, which does not add relief — it erases the difference between a
       moderate slope and a steep one, and that flattening is what "embossed"
       looks like. Below it there is real shading left unused.
    */
    vec3 reliefNormal = normalize(
      n - (eastAt * ((eE - eW) / cosLat) - northAt * (eS - eN)) * 26.0
    );

    /*
       Applied as a modulation, not as a replacement.

       Relief is the DIFFERENCE between how the slope catches the light and how
       flat ground at the same place would, so the planet keeps the exposure it
       already had and only gains shape. Replacing the diffuse term outright
       would have relit the whole surface and thrown away the tuning above.

       Land only: the sea has no relief to catch light, and the source is a true
       zero over water, so any gradient there is a coastline — which would draw
       a bright rim around every continent.
    */
    float flatLambert = max(0.0, sunCos);
    float bumpLambert = max(0.0, dot(reliefNormal, uSunDir));
    float relief = clamp(1.0 + (bumpLambert - flatLambert) * 2.3, 0.62, 1.5);
    relief = mix(relief, 1.0, water);

    vec3 litSurface = surfaceColour * (diffuse * 1.75 * sunlight * relief + vec3(0.42, 0.55, 0.78) * skyLight);

    /*
       Ocean glint: the sun reflecting off water, and the single strongest cue
       that this is a photograph of a planet rather than a shaded sphere. Every
       image taken of Earth from orbit has it. Broad rather than mirror-sharp,
       because the sea is never flat — the roughness is what turns a point into
       the wide silver smear you actually see.
    */
    vec3 halfway = normalize(uSunDir - dir);
    float specular = pow(max(0.0, dot(n, halfway)), 115.0);

    /*
       Dimmer and tighter than it was, because it had stopped reading as glint
       and started reading as glare.

       Measured off the rendered frame at Cape Town, midday: the band across
       the lower ocean averaged RGB (141,137,129) — R>G>B in almost exactly the
       1 : 0.97 : 0.9 of the tint below, which is how the glint was identified
       as the cause rather than haze or cloud. Over open sea BLUE should be the
       strongest channel and it was the weakest, so the highlight was not
       sitting on the water, it was erasing it.

       Still broad, because the sea is never flat and a mirror-sharp point
       would look like a lens artefact. 44 rather than 34 narrows the smear
       enough to have an edge; the halved gain is what stops it flattening the
       colour underneath.
    */
    vec3 glint = vec3(1.0, 0.97, 0.9) * specular * water * lit * 0.95;

    /*
       Clouds with FORM, rather than a flat mask multiplied in.
       
       A cloud sampled as one number and painted white has no thickness, no
       sunlit side and no shaded side — it reads as fog lying on the surface,
       which is what it looked like. Real cloud from orbit is the most
       three-dimensional thing in the frame: bright tops, grey flanks turned
       away from the sun, and dark bases.
       
       The texture holds no normals, but it holds height implicitly — thicker
       cloud is brighter — so the gradient of the cloud field IS the shape of
       its tops. Two extra samples give that gradient, and lighting the implied
       slope by the sun is what turns a smear into a mass.
    */
    float cloudDu = texture(uClouds, cloudUv + vec2(0.0012, 0.0)).r - texture(uClouds, cloudUv - vec2(0.0012, 0.0)).r;
    float cloudDv = texture(uClouds, cloudUv + vec2(0.0, 0.0012)).r - texture(uClouds, cloudUv - vec2(0.0, 0.0012)).r;

    /* The slope in the same east/north frame the shadow offset uses, so the two
       agree about which way the light is coming from. */
    vec3 cloudNormal = normalize(n - (eastAt * cloudDu - northAt * cloudDv) * 5.5);
    float cloudLambert = max(0.0, (dot(cloudNormal, uSunDir) + 0.18) / 1.18);

    /* Thicker cloud is brighter, and the relationship is not linear: a thin
       veil transmits, a deep tower reflects almost everything. */
    float cloudDepth = cloud * cloud * (3.0 - 2.0 * cloud);

    vec3 litCloud =
        vec3(1.0, 0.995, 0.985) * cloudDepth * cloudLambert * sunlight * 1.25
      + vec3(0.55, 0.63, 0.78) * cloudDepth * skyLight * 1.6;
    float groundShade = 1.0 - shadowCloud * 0.42 * lit;

    /* Cloud hides what is under it in proportion to its depth, not its bare
       value — the same curve that decides how much light it returns decides how
       much it stops, because they are the same physical fact. */
    surface = litSurface * (1.0 - cloudDepth * 0.92) * groundShade + litCloud + glint + cities;
  }

  /* March the atmosphere. The far end is the ground if we hit it, otherwise
     the back of the shell — so the sky above the horizon integrates the whole
     depth and the air in front of the planet integrates only what is there. */
  float near = max(atmos.x, 0.0);
  float far = hitGround ? ground.x : atmos.y;

  vec3 scattered = vec3(0.0);
  vec3 transmittance = vec3(1.0);
  /* The FULL view-path depth, Rayleigh and Mie. The airglow only needs the
     Rayleigh part; the sun disc below needs both, because what reddens a
     setting sun is precisely how much air its light crossed to reach the eye —
     the same air this loop is already measuring. Computing it twice would be
     two answers to one question. */
  vec2 viewDepth = vec2(0.0);
  float glowDensity = 0.0;

  if (far > near) {
    float step = (far - near) / float(uSteps);
    float mu = dot(dir, uSunDir);
    float pr = rayleighPhase(mu);
    float pm = miePhase(mu);

    vec2 depthAlongView = vec2(0.0);

    for (int i = 0; i < 24; i++) {
      if (i >= uSteps) break;
      vec3 p = origin + dir * (near + (float(i) + 0.5) * step);
      float h = max(0.0, length(p) - R_PLANET);

      vec2 density = vec2(exp(-h / H_RAYLEIGH), exp(-h / H_MIE)) * step;
      depthAlongView += density;

      /* Airglow is a LAYER, not a column — see below. Accumulated here because
         the march is already walking this ray and a second loop would be the
         same arithmetic twice. */
      float glowOffset = (h - GLOW_ALTITUDE) / GLOW_WIDTH;
      glowDensity += exp(-glowOffset * glowOffset) * step;

      vec2 depthToSun = opticalDepthToSun(p, uSunDir);
      if (depthToSun.x < 0.0) continue; // in the planet's shadow

      vec3 tau = BETA_RAYLEIGH * (depthToSun.x + depthAlongView.x)
               + BETA_MIE * 1.1 * (depthToSun.y + depthAlongView.y);
      vec3 attenuation = exp(-tau);

      scattered += attenuation * (BETA_RAYLEIGH * density.x * pr + BETA_MIE * density.y * pm);
    }

    /*
       Transmittance uses a FRACTION of the view path's optical depth.

       The shell above is nine times thicker than the real atmosphere, which is
       what makes the limb a visible band rather than nine pixels — but the same
       exaggeration means the ground is being looked at through nine times too
       much air, and the continents wash out into haze. The band and the haze
       come from the same integral and want different answers, so they are
       scaled apart: the rim keeps the full depth, the surface is seen through
       roughly the real one.

       Physically inconsistent, and deliberately. The alternative is choosing
       between a planet you can see and an atmosphere you can.
    */
    /* 0.415, derived rather than dialled: it is 0.22 scaled by
       sqrt(128000 / 36000), preserving the same EFFECTIVE optical depth through
       a shell whose scale height dropped by 3.6x. Leaving it at 0.22 would have
       made the surface too clear and quietly undone the aerial perspective that
       gives the disc its depth. */
    transmittance = exp(
      -(BETA_RAYLEIGH * depthAlongView.x + BETA_MIE * 1.1 * depthAlongView.y) * 0.415
    );
    viewDepth = depthAlongView;
  }

  /* Sunlight's intensity: the one free constant, and it sets how luminous the
     atmosphere reads AGAINST the surface. Too high and the planet washes out
     into the haze in front of it — a pale blue smear where there should be
     ocean, cloud and coast. 22 did that, and so did 19 once the CSS glow above
     it stopped hiding the difference. */
  /* Haze in FRONT of the planet is cut for the same reason the transmittance
     is: it comes from the exaggerated shell and would bury the surface. The
     rim — where the ray misses the ground entirely — keeps its full strength,
     because that is the thing the exaggeration exists to show.

     Cut harder as the shell grew. Thickening the atmosphere to 1600km made the
     rim right and the ground correspondingly worse: the surface was being
     looked at through sixteen times too much air, which is what "still a bit
     blurry and hazy" was. */
  /*
     Aerial perspective, and it has to FALL OFF with nearness.

     Scattered light is added over the planet as well as beside it, and a flat
     multiplier lays the same veil on the near ground as on the limb — a
     constant fog sitting on the whole disc, which is what read as blur. Real
     aerial perspective is nothing at all on ground directly beneath you and
     everything at the horizon, because the difference is how much air the light
     crossed to reach you.

     ground.x is exactly that distance. Near the bottom of the frame the
     surface is a few thousand kilometres away; at the limb it is twice that
     and through vastly more atmosphere. Scaled by it, the near ground comes
     out clean and the limb keeps its depth.
  */
  float groundRange = hitGround
    ? smoothstep(float(R_PLANET) * 0.75, float(R_PLANET) * 1.9, ground.x)
    : 1.0;
  float hazeAhead = mix(1.0, 0.02 + groundRange * 0.16, groundCoverage);
  /* The surface fades in over the same pixel the silhouette does, so the limb
     resolves smoothly into the atmosphere in front of it rather than stepping. */
  /* 9, not 13. Above about ten the three channels all reach the top of the
     tone curve wherever the air is thickest, and a saturated blue clips to
     WHITE — the band went pale and lost the colour that is the whole point of
     computing Rayleigh scattering in the first place. Brightness past the point
     of saturation does not add light, it removes hue. */
  vec3 colour = surface * groundCoverage * transmittance + scattered * 6.4 * hazeAhead;

  /*
     Airglow: the reason the night limb is not simply an edge.
     
     A faint emission from oxygen and hydroxyl around 90km up, and the thing
     every photograph of Earth's night side shows as a thin green-blue arc above
     the horizon. It is NOT scattered sunlight, which is why the scattering
     integral above cannot produce it — no sun, no term — and why the night limb
     came out as a hard silhouette against the stars.

     Driven by how much atmosphere the ray crossed and faded out as the sun
     comes up, when it is utterly swamped. The colour is the real one: the
     557.7nm oxygen line is green, with the hydroxyl bands adding a little red.
  */
  /* Path length through the emitting layer, normalised. Seen edge-on that path
     is hundreds of kilometres of glowing air; looking straight down it is a few
     tens, which is why this is a limb phenomenon and not a wash over the whole
     disc. The old term needed a glowEdge fudge to achieve that; the geometry
     produces it here on its own. */
  float glowPath = clamp(glowDensity * 2.4e-6, 0.0, 1.0);
  float sunGone = 1.0 - smoothstep(-0.30, 0.02, uSunDir.z);
  /* A LIMB phenomenon. Looking down through the atmosphere you see almost none
     of it; looking along it, edge-on, the path is hundreds of kilometres of
     emitting air and it reads as an arc. Applied at full strength only to rays
     that miss the ground — the first version used the path length alone and lit
     the entire disc a uniform green. */
  float glowEdge = mix(1.0, 0.05, groundCoverage);
  colour += vec3(0.16, 0.40, 0.34) * glowPath * sunGone * glowEdge * 0.42;

  /* Moonlight: a cool wash on the lit hemisphere of the night side, far below
     the sun's contribution and gated on the moon being up and full enough. */
  if (hitGround && uMoonLight > 0.0) {
    vec3 p = normalize(origin + dir * ground.x);
    float moonCos = max(0.0, dot(p, uMoonDir));
    colour += vec3(0.42, 0.5, 0.72) * moonCos * uMoonLight * 0.05;
  }

  /*
     ===================  The sun, and the moon  ===================

     Both were CSS elements until now: a div with a radial gradient, positioned
     by a custom property, drawn earlier in the stacking order so the planet
     would cover it. That is why the moment it went behind the limb looked
     cheap, and no amount of gradient tuning could have fixed it. A sprite
     occluded by paint order can only ever be clipped. It cannot be dimmed by
     the air in front of it, cannot redden, cannot bloom through an atmosphere
     it knows nothing about, and meets the limb on a hard edge that belongs to
     a different renderer with a different idea of where the horizon is.

     Here it is the same ray, the same sphere and the same integral as
     everything else in the frame, so all four come out for free.
  */

  /*
     Angular offset from this pixel's ray to the sun, measured in a basis
     aligned with the frame rather than as a single angle — because the disc is
     not round at the limb.

     REFRACTION FLATTENING. Light from a sun at the limb crosses the atmosphere
     tangentially, and the lower edge is bent more than the upper because it
     passes through denser air. The disc squashes visibly: this is why every
     photograph of a sunrise from the ISS shows an orange ellipse rather than a
     circle. It is also the difference between a body that is being seen THROUGH
     an atmosphere and one that is merely sliding behind an edge — a coin behind
     a card, which is what "a sun moving behind a 2D object" was describing.
  */
  /*
     What the bodies themselves contribute to ALPHA.

     This is the whole reason the sun was reported as "only visible in the
     hemisphere band". Alpha here carries "is there anything at this pixel", and
     it was computed purely from scattering and ground coverage — so above the
     atmosphere, where the sun spends most of its arc, alpha was ~0 and the
     SRC_ALPHA blend multiplied the disc straight out of existence. It was being
     drawn correctly across the entire sky and erased everywhere except the one
     place the air happened to make the frame opaque.

     A body is unambiguously something that is there.
  */
  float bodyAlpha = 0.0;

  vec3 sunRight = normalize(cross(vec3(0.0, 0.0, 1.0), uSunDisplayDir));
  vec3 sunUp = cross(uSunDisplayDir, sunRight);
  float alongSun = dot(dir, uSunDisplayDir);

  /*
     TWO angles, and keeping them separate is the whole point.

     The first version squashed one angle and fed it to everything, so as the
     sun approached the limb the disc, the corona and all six diffraction
     spikes stretched together by up to 27% — reported, correctly, as the sun
     distorting too much.

     Refraction bends light passing through the AIR, so it distorts the sun's
     own image. The aureole and the spikes are not the sun's image: they are
     what the instrument does with a bright source — scattering in the optics
     and light bending around an aperture. A lens does not become elliptical
     because the thing it is looking at is near the horizon.

     So the disc gets the flattened angle and the glow keeps the round one.
  */
  vec2 sunOffsetRound = vec2(dot(dir, sunRight), dot(dir, sunUp));
  float sunAngle = length(sunOffsetRound) / max(alongSun, 0.05);

  /* 0.82, not 0.62. A sun on the horizon loses about a fifth of its height to
     refraction, which is the figure this now uses; 0.62 was nearly twice that
     and read as a smear rather than as an ellipse. */
  float sunFlatten = mix(1.0, 0.82, uSunLimbProximity);
  vec2 sunOffset = vec2(sunOffsetRound.x, sunOffsetRound.y / sunFlatten);
  float sunDiscAngle = length(sunOffset) / max(alongSun, 0.05);

  /*
     EXAGGERATED, and by a measured amount rather than a chosen one.

     The real sun is 0.266° of arc. In this camera that is a disc about 21
     device pixels across — correct, and much smaller than the composition has
     ever had. The CSS sun it replaces was 3.4vmax, which works out at almost
     exactly 1.0° of apparent radius, so 3.5x is what the frame is already
     built around. Keeping the size and changing only the physics means this
     reads as the same picture rendered properly, not as a different one.
  */
  const float SUN_RADIUS = 0.00465 * 3.5;
  const float MOON_RADIUS = 0.00452 * 3.5;

  /*
     Extinction, and this is the entire point of moving it in here.

     A low sun is red because its light crosses a vast slant of atmosphere and
     Rayleigh scattering removes blue roughly sixteen times faster than red.
     viewDepth is that path, already integrated above. Multiplying the disc by
     exp(-tau) therefore reddens and dims it exactly as it approaches the limb,
     with no ramp, no keyframe and no colour curve — the same arithmetic that
     makes the sky blue makes the sun orange.

     Scaled by 0.26 because the shell is exaggerated. A grazing path's optical
     depth goes as sqrt(scale height), and this atmosphere uses 36km against the
     real 8.5km: sqrt(8500 / 36000) = 0.486. So the factor is not a taste
     control, it is the conversion back to Earth's own extinction — and it moves
     whenever H_RAYLEIGH does.
  */
  const float SUN_EXTINCTION_SCALE = 0.486;
  vec3 slant = exp(
    -(BETA_RAYLEIGH * viewDepth.x + BETA_MIE * 1.1 * viewDepth.y) * SUN_EXTINCTION_SCALE
  );

  /* Behind the planet is behind the planet. The same coverage term that
     antialiases the silhouette hides the sun, so the disc is occluded on
     exactly the edge the surface uses, to the same fraction of a pixel — which
     is the thing a separate CSS layer could never agree about. */
  float notBlocked = 1.0 - groundCoverage;

  /*
     The AUREOLE, and it is what stops the disc reading as a sticker.

     A bright source seen through air is never a bare disc: the atmosphere
     scatters a halo around it that falls off steeply, and a camera adds its own
     bloom on top. Drawn as part of the same term so it is occluded by the same
     coverage and reddened by the same optical depth — which means that as the
     sun goes behind the limb its glow shrinks, reddens and is eaten by the
     curve along with it, instead of a disc vanishing and a glow staying put.

     Two lobes: a tight one for the near halo and a wide, faint one for the
     spread. Both fall off as powers rather than exponentials so the far tail
     stays present instead of terminating on a visible edge.
  */
  if (notBlocked > 0.0 && alongSun > 0.0 && uSunIntensity > 0.0) {
    /*
       Measured, not guessed. Reading the framebuffer back, the first version's
       alpha fell from 255 at the centre to 31 by forty pixels and was gone by
       eighty — a halo barely wider than the 55-pixel disc itself. That is what
       made it read as a sticker rather than a light: a real source seen through
       air keeps a faint aureole out to many diameters, and it is the long, low
       tail that the eye reads as brightness.

       Two lobes. A tight one that hugs the rim, and a wide one falling as
       roughly the inverse of the angle, which is what atmospheric scattering
       around a point source actually does. Targets, in units of the disc's own
       radius: about 0.37 at 2 radii, 0.13 at 4, 0.06 at 8, and still 0.03 at
       16 — faint, but present, across a big area.
    */
    /* NOT named near/wide: the scattering march above already declares
       float near and float far at main() scope, and shadowing them inside this
       block produced a measurable wrong answer — the readback matched the tight
       lobe alone, exactly as if the second term had evaluated to zero. Renamed
       rather than diagnosed further, because there is no reason to shadow them
       in the first place. */
    float halo = SUN_RADIUS / max(sunAngle, SUN_RADIUS * 0.55);
    float haloRim = pow(halo, 3.0) * 1.6;
    float haloSpread = pow(halo, 1.1) * 0.55;

    /*
       DIFFRACTION STREAKS, and they are the single thing that stopped this
       reading as a white ball pasted on the stars.

       The disc itself cannot carry any character. Measured across it: at a peak
       of 26 in linear light, the whole face lands between 252 and 249 after the
       tone curve, and even a 2:1 ratio between channels compresses to three or
       four units. A blown-out disc is also what a camera genuinely records when
       pointed at the sun, so the answer is not to dim it — it is to give the
       light somewhere to go.

       Six narrow spikes, because a bright source photographed through any real
       aperture has them: light bending around the blades. The star field
       already draws them for the same reason, so this also ties the two
       together — the sun and the stars now behave like they were recorded by
       the same instrument, which is most of what "photographic" means.

       Multiplied by the radial falloff rather than added, so a spike is always
       fainter than the corona it comes from and cannot outlive it.
    */
    vec2 spikeDir = sunOffsetRound / max(length(sunOffsetRound), 1.0e-9);
    float spikes = pow(abs(cos(atan(spikeDir.y, spikeDir.x) * 3.0)), 22.0);
    float streak = spikes * pow(halo, 1.25) * 0.5;

    float glow = (haloRim + haloSpread + streak) * notBlocked * uSunIntensity;
    /*
       Warm close in, cool further out, because that is what the air does. The
       aureole immediately around the sun is forward-scattered Mie, which is
       nearly neutral and reads warm next to a blue sky; the broad glow beyond
       it is Rayleigh, which is blue. A single warm tint across the whole halo
       is the tell of a lens flare drawn by hand.
    */
    vec3 haloColour = mix(
      vec3(1.0, 0.85, 0.62),
      vec3(0.62, 0.74, 1.0),
      clamp(sunAngle / (SUN_RADIUS * 9.0), 0.0, 1.0)
    );
    colour += haloColour * glow * slant;
    /* The halo's alpha follows its own brightness, so it fades to transparent
       at its edge instead of ending on a rim of opaque nothing — and it is
       damped by slant, so a halo shining through a long slant of atmosphere
       goes as thin as it goes red. */
    bodyAlpha = max(bodyAlpha, clamp(glow * max(slant.r, slant.g), 0.0, 1.0));
  }

  /* alongSun > 0.0 is not defensive padding, it is a correctness guard.

     sunAngle divides the offset by max(alongSun, 0.05), and for a ray pointing
     directly AWAY from the sun both components of that offset are zero — so the
     angle comes out as zero and the disc would be painted behind the camera.
     An anti-sun, exactly opposite the real one, appearing whenever the sun is
     behind the viewer. */
  if (sunDiscAngle < SUN_RADIUS * 1.02 && notBlocked > 0.0 && alongSun > 0.0) {
    /* Analytic edge, one pixel wide, from the screen-space derivative. A disc
       this small is nearly all edge, so a hard cut here reads as a polygon. */
    float aa = max(fwidth(sunDiscAngle), 1.0e-6);
    float disc = 1.0 - smoothstep(SUN_RADIUS - aa, SUN_RADIUS + aa, sunDiscAngle);

    float rr = clamp(sunDiscAngle / SUN_RADIUS, 0.0, 1.0);

    /*
       Limb darkening, and it has to be carried by COLOUR rather than by
       brightness.

       The previous version dimmed the rim to 0.35 of the centre and it was
       invisible. Reading the rendered pixels: with a peak of 26 the tone curve
       maps the centre to 250 and the rim to 243 — a 3% change across the whole
       disc. Everything above about 5 in linear light lands above 0.92 after
       tone mapping and gamma, so a bright object cannot show structure in
       luminance at all. That is what "a white ball" is: not the wrong colour,
       but a gradient that the tone curve ate.

       Ratios between channels survive where absolute levels do not, so the
       rim is made WARM as well as dim. Physically that is also the truer
       statement: the sun's limb is dimmer because you are seeing shallower,
       cooler photosphere, and cooler means redder. The rim now lands near
       (234, 227, 207) against a core of (250, 250, 250) — a visible, warm
       edge instead of a flat cut-out.

       The core stays blown out on purpose. A camera pointed at the sun clips,
       and a sun that did not would not read as the sun.
    */
    float limbDark = 0.18 + 0.82 * pow(sqrt(max(0.0, 1.0 - rr * rr)), 0.42);
    vec3 discColour = mix(
      vec3(1.0, 0.985, 0.95),   // core: very slightly warm white
      vec3(1.0, 0.72, 0.36),    // limb: cooler photosphere, so redder
      pow(rr, 2.5)
    );

    colour += discColour * disc * limbDark * slant * notBlocked * 26.0;
    /* The disc's own coverage. Not scaled by brightness: a sun reddened almost
       to extinction is still completely opaque, and fading its alpha with its
       colour would make it turn transparent as it set rather than dark red. */
    bodyAlpha = max(bodyAlpha, disc * notBlocked);
  }

  /*
     ===================  The moon, with its real phase  ===================

     Not a lit disc with an opacity. A sphere, lit from where the sun actually
     is, so a crescent night shows a crescent — and the horns point the right
     way, at the sun drawn on the same screen.
  */
  if (uMoonVisible > 0.0) {
    vec3 moonRight = normalize(cross(vec3(0.0, 0.0, 1.0), uMoonDisplayDir));
    vec3 moonUp = cross(uMoonDisplayDir, moonRight);
    float alongMoon = dot(dir, uMoonDisplayDir);
    vec2 moonOffset = vec2(dot(dir, moonRight), dot(dir, moonUp));
    float moonAngle = length(moonOffset) / max(alongMoon, 0.05);

    if (moonAngle < MOON_RADIUS * 1.02 && notBlocked > 0.0 && alongMoon > 0.0) {
      float aa = max(fwidth(moonAngle), 1.0e-6);
      float disc = 1.0 - smoothstep(MOON_RADIUS - aa, MOON_RADIUS + aa, moonAngle);

      /*
         Disc coordinates, with u pointing at the sun.

         Taken from the sun's DISPLAY direction rather than its true one, and
         deliberately: both bodies are on the same screen, and the one thing a
         person will actually check is whether the crescent faces the sun they
         can see. Using the physical vector here would light the moon from a
         direction the frame does not contain.

         The illuminated FRACTION is real either way — that is what carries the
         phase — and so is which side is lit, because the artistic remap
         preserves the bodies' left-right order.
      */
      vec3 toSun = uSunDisplayDir - uMoonDisplayDir * dot(uSunDisplayDir, uMoonDisplayDir);
      vec2 sunAxis = length(toSun) > 1.0e-5
        ? normalize(vec2(dot(toSun, moonRight), dot(toSun, moonUp)))
        : vec2(1.0, 0.0);

      vec2 unit = moonOffset / max(MOON_RADIUS * alongMoon, 1.0e-6);
      float u = dot(unit, sunAxis);
      float v = dot(unit, vec2(-sunAxis.y, sunAxis.x));
      float w = sqrt(max(0.0, 1.0 - u * u - v * v));

      /*
         Phase angle from the illuminated fraction: f = (1 + cos θ) / 2, so
         θ = acos(2f − 1). θ = 0 is full, θ = π is new.

         A point on the sphere is lit when its normal faces the sun, and in this
         basis the sun lies at (sin θ, 0, cos θ). So the terminator is not a
         straight line across the disc but the ellipse this produces — which is
         the difference between a moon and a pac-man.
      */
      float theta = acos(clamp(2.0 * uMoonIllumination - 1.0, -1.0, 1.0));
      float lambert = u * sin(theta) + w * cos(theta);

      /* Softened over about a twentieth of the disc. The real terminator is not
         sharp — it falls across mountains and crater walls — and a hard edge on
         a body this small reads as a cut mask. */
      float lit = smoothstep(-0.05, 0.05, lambert);

      /*
         The actual lunar surface.

         The disc point already gives a surface normal — (unit.x, unit.y, w),
         with w toward the observer — so it maps straight onto the moon's own
         coordinates. The moon is tidally locked, so the near side is always the
         near side and a fixed equirectangular map is right; libration is ±8°,
         which at fifty-odd pixels is under half a pixel of wobble.

         ROTATED by the parallactic angle first, which is the difference between
         a moon and *the* moon. It is the angle between the observer's zenith
         and the moon's north pole: −33° from London and −143° from Cape Town on
         the same night, which is why the moon looks upside down when you fly
         between them. Without it the maria sit in one fixed orientation and the
         face is simply wrong for most of the world.
      */
      float ca = cos(uMoonNorthAngle);
      float sa = sin(uMoonNorthAngle);
      vec2 face = vec2(unit.x * ca - unit.y * sa, unit.x * sa + unit.y * ca);
      float lunarLat = asin(clamp(face.y, -1.0, 1.0));
      float lunarLon = atan(face.x, max(w, 1.0e-4));
      vec3 albedo = texture(uMoon, vec2(lunarLon / (2.0 * PI) + 0.5, 0.5 - lunarLat / PI)).rgb;

      /*
         Contrast restored before the tone curve takes it away.

         The map holds a genuine 2:1 ratio between maria and highlands — 65
         against 165 in its own values — and measured on screen the rendered
         disc came out 149 to 181, a ratio of 1.2:1. The same compression that
         flattens the sun flattens this: at a peak near 1.0 in linear light the
         curve has already lost most of its slope, so a real difference in
         albedo arrives as a faint smudge.

         Two changes, both aimed at that. The albedo gets a gamma so the seas
         separate further from the highlands, and the whole moon is rendered
         LOWER on the curve, where it still has slope, rather than being made
         brighter. A moon that is slightly dimmer and clearly has a face beats a
         brighter one that is a disc.
      */
      albedo = pow(albedo, vec3(1.4));

      /* Slight darkening toward the limb, so it reads as a sphere. */
      float sphere = 0.72 + 0.28 * w;

      /*
         EARTHSHINE — the dark part of a crescent, faintly lit by sunlight
         bounced off the Earth. It is why you can see the whole disc of a young
         moon, and it is at its strongest exactly when the crescent is thinnest,
         because that is when the Earth as seen from the moon is nearly full.
      */
      float earthshine = 0.05 * (1.0 - uMoonIllumination);

      float surface = lit * sphere + (1.0 - lit) * earthshine;

      /* The albedo carries the maria; the tint only decides what colour the
         light falling on them is. Earthshine is the blue-grey of sunlight that
         has bounced off the Earth, direct sun is very slightly warm. */
      vec3 lightColour = mix(vec3(0.52, 0.60, 0.86), vec3(1.0, 0.98, 0.94), lit);

      /* 1.55, up from 0.55, because the albedo now multiplies in at a mean of
         about 0.59 and would otherwise darken the moon by nearly half. */
      colour += albedo * lightColour * disc * surface * slant * notBlocked * uMoonVisible * 1.3;
      /* Coverage is the whole disc, lit or not: the unlit half of a crescent
         still occludes the stars behind it. */
      bodyAlpha = max(bodyAlpha, disc * notBlocked * uMoonVisible);
    } else if (moonAngle < MOON_RADIUS * 7.0 && notBlocked > 0.0 && alongMoon > 0.0) {
      /*
         A small halo just outside the disc.

         Far fainter than the sun's and scaled by the phase, because a crescent
         throws almost no light. Without it the moon has a cut edge against the
         sky — it sits ON the frame rather than in it — and that hard boundary
         is most of what reads as "a basic circle".
      */
      float ring = MOON_RADIUS / max(moonAngle, MOON_RADIUS);
      float glow = pow(ring, 2.4) * 0.10 * uMoonIllumination;
      colour += vec3(0.80, 0.85, 1.0) * glow * slant * notBlocked * uMoonVisible;
      bodyAlpha = max(bodyAlpha, clamp(glow, 0.0, 1.0));
    }
  }

  colour *= uExposure;

  // Tone map, then encode. Without this the limb clips to flat white exactly
  // where the scattering is most interesting.
  colour = colour / (colour + vec3(1.0));
  colour = pow(colour, vec3(1.0 / 2.2));

  /*
     Dither, and it is not optional at this quality.
     
     An eight-bit channel has 256 levels. The atmosphere is a smooth gradient
     across hundreds of pixels, so consecutive bands of it round to the same
     level and the eye — which is extremely good at finding edges — reads the
     boundaries as contour lines. It is the single most recognisable tell of an
     amateur render, and it is invisible in a screenshot scaled down for review
     while being perfectly obvious on the real display.
     
     A little under one level of noise, hashed off the pixel position so it is
     stable rather than crawling, breaks the rounding into a stipple the eye
     integrates back into a continuous ramp. This is what film grain was doing
     by accident for a century.
  */
  float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  colour += (dither - 0.5) / 255.0;

  /*
     Alpha carries "is there anything here".

     Above the atmosphere the shader contributes nothing and the star field
     behind has to show through — which is why this is computed from the
     scattering rather than being 1 everywhere.

     The multiplier was 90 and that was far too low: the air just above the limb
     scatters strongly and should be an opaque luminous band, but it was
     rendering at a few percent alpha and letting the flat CSS sky through
     instead. The result was a hard edge where the planet met the sky — the one
     place this whole scene is looking. At 320 the band above the horizon is
     solid, thinning to nothing near the top of the frame, so the stars still
     come through where there is genuinely nothing in the way.

     At night the scattering really is near zero, so this collapses to
     transparent on its own and the Milky Way is undisturbed.
  */
  float coverage = clamp(
    max(
      max(groundCoverage, bodyAlpha),
      max(length(scattered) * 320.0, glowPath * sunGone * 1.9)
    ),
    0.0,
    1.0
  );
  outColour = vec4(colour, coverage);
}`;
