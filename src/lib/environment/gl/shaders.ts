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
    vec3 litSurface = surfaceColour * (diffuse * 1.75 * sunlight + vec3(0.42, 0.55, 0.78) * skyLight);

    /*
       Ocean glint: the sun reflecting off water, and the single strongest cue
       that this is a photograph of a planet rather than a shaded sphere. Every
       image taken of Earth from orbit has it. Broad rather than mirror-sharp,
       because the sea is never flat — the roughness is what turns a point into
       the wide silver smear you actually see.
    */
    vec3 halfway = normalize(uSunDir - dir);
    float specular = pow(max(0.0, dot(n, halfway)), 34.0);
    vec3 glint = vec3(1.0, 0.97, 0.9) * specular * water * lit * 2.6;

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

  /* Angular distance from this pixel's ray to each body. */
  float sunAngle = acos(clamp(dot(dir, uSunDir), -1.0, 1.0));

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

  if (sunAngle < SUN_RADIUS * 1.02 && notBlocked > 0.0) {
    /* Analytic edge, one pixel wide, from the screen-space derivative. A disc
       this small is nearly all edge, so a hard cut here reads as a polygon. */
    float aa = max(fwidth(sunAngle), 1.0e-6);
    float disc = 1.0 - smoothstep(SUN_RADIUS - aa, SUN_RADIUS + aa, sunAngle);

    /*
       Limb darkening — the sun's edge really is dimmer than its centre, by
       about a third in visible light, because looking at the edge you see
       shallower and cooler layers of the photosphere. It is the difference
       between a disc that reads as a sphere of gas and one that reads as a
       flat sticker, and it costs a square root.
    */
    float rr = clamp(sunAngle / SUN_RADIUS, 0.0, 1.0);
    float limbDark = 0.35 + 0.65 * pow(sqrt(max(0.0, 1.0 - rr * rr)), 0.42);

    colour += vec3(1.0, 0.96, 0.90) * disc * limbDark * slant * notBlocked * 26.0;
  }

  if (uMoonVisible > 0.0) {
    float moonAngle = acos(clamp(dot(dir, uMoonDir), -1.0, 1.0));
    if (moonAngle < MOON_RADIUS * 1.02 && notBlocked > 0.0) {
      float aa = max(fwidth(moonAngle), 1.0e-6);
      float disc = 1.0 - smoothstep(MOON_RADIUS - aa, MOON_RADIUS + aa, moonAngle);
      /* Lambertian rather than limb-darkened: the moon is dust, not gas, and
         its edge stays bright right to the terminator — which is why a full
         moon looks like a disc and not a ball. */
      colour += vec3(0.94, 0.94, 0.99) * disc * slant * notBlocked * uMoonVisible * 0.5;
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
    max(groundCoverage, max(length(scattered) * 320.0, glowPath * sunGone * 1.9)),
    0.0,
    1.0
  );
  outColour = vec4(colour, coverage);
}`;
