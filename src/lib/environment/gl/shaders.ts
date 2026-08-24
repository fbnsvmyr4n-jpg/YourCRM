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
uniform float uCameraHeight;  // metres above the surface
uniform float uFov;           // vertical field of view, radians
uniform float uPitch;         // camera tilt below horizontal, radians
uniform float uYaw;           // compass bearing the camera faces, radians
uniform mat3  uEnuToEcef;     // observer's local frame into earth-fixed
uniform float uExposure;
uniform int   uSteps;         // view samples through the atmosphere
uniform int   uLightSteps;    // light samples toward the sun

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

   Every space visualisation exaggerates this and so does this one — to 900km,
   which sounds absurd until you do the angles. From 5,500km the planet's
   angular radius is 32.4°; a real atmosphere reaches 33.0°, a band of 0.6°, or
   about nine pixels in a 58° frame. Rendering it honestly produced a hard edge
   and nothing else, which I could only prove by hiding the CSS scene and
   finding the shader's sky completely black. At 900km the band is 5.4° — around
   eighty pixels — which is what the reference frames actually show.

   The scale heights below are stretched by the same factor so the density
   profile still fills the shell rather than hugging the ground inside a
   suddenly enormous void. Scaling the shell alone thins the band out instead of
   thickening it, which is the trap here: the shell says where air can be, the
   scale height says where it actually is.
*/
const float R_PLANET = 6371000.0;
const float R_ATMOS  = 7271000.0;

/* Rayleigh scattering per metre at sea level, per channel. Blue scatters an
   order of magnitude more than red — this triple IS why the sky is blue and
   why a low sun is orange. */
const vec3  BETA_RAYLEIGH = vec3(5.8e-6, 13.5e-6, 33.1e-6);
const float BETA_MIE      = 21e-6;

/* How fast each falls off with altitude, stretched to match the shell above. */
const float H_RAYLEIGH = 72000.0;
const float H_MIE      = 11000.0;

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
    float cloud = texture(uClouds, uv).r;

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
    vec3 cities = max(vec3(0.0), night - 0.36) * 5.0 * (1.0 - lit) * (1.0 - cloud * 0.75);

    // Lambert, with a little wrap so the limb does not go abruptly black.
    float diffuse = max(0.0, (sunCos + 0.08) / 1.08);
    vec3 litSurface = day * diffuse * 1.7;
    vec3 litCloud = vec3(1.0) * cloud * diffuse * 0.9;

    surface = litSurface * (1.0 - cloud * 0.85) + litCloud + cities;
  }

  /* March the atmosphere. The far end is the ground if we hit it, otherwise
     the back of the shell — so the sky above the horizon integrates the whole
     depth and the air in front of the planet integrates only what is there. */
  float near = max(atmos.x, 0.0);
  float far = hitGround ? ground.x : atmos.y;

  vec3 scattered = vec3(0.0);
  vec3 transmittance = vec3(1.0);
  /* Kept outside the block below so the airglow term can use it: how much air
     this ray crossed is exactly what decides how much glow it picks up. */
  float depthAlongViewLength = 0.0;

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
    transmittance = exp(
      -(BETA_RAYLEIGH * depthAlongView.x + BETA_MIE * 1.1 * depthAlongView.y) * 0.22
    );
    depthAlongViewLength = depthAlongView.x;
  }

  /* Sunlight's intensity: the one free constant, and it sets how luminous the
     atmosphere reads AGAINST the surface. Too high and the planet washes out
     into the haze in front of it — a pale blue smear where there should be
     ocean, cloud and coast. 22 did that, and so did 19 once the CSS glow above
     it stopped hiding the difference. */
  /* Haze in FRONT of the planet is cut for the same reason the transmittance
     is: it comes from the exaggerated shell and would bury the surface. The
     rim — where the ray misses the ground entirely — keeps its full strength,
     because that is the thing the exaggeration exists to show. */
  float hazeAhead = hitGround ? 0.3 : 1.0;
  vec3 colour = surface * transmittance + scattered * 13.0 * hazeAhead;

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
  float glowPath = clamp(depthAlongViewLength * 3.0e-6, 0.0, 1.0);
  float sunGone = 1.0 - smoothstep(-0.30, 0.02, uSunDir.z);
  /* A LIMB phenomenon. Looking down through the atmosphere you see almost none
     of it; looking along it, edge-on, the path is hundreds of kilometres of
     emitting air and it reads as an arc. Applied at full strength only to rays
     that miss the ground — the first version used the path length alone and lit
     the entire disc a uniform green. */
  float glowEdge = hitGround ? 0.05 : 1.0;
  colour += vec3(0.16, 0.40, 0.34) * glowPath * sunGone * glowEdge * 0.16;

  /* Moonlight: a cool wash on the lit hemisphere of the night side, far below
     the sun's contribution and gated on the moon being up and full enough. */
  if (hitGround && uMoonLight > 0.0) {
    vec3 p = normalize(origin + dir * ground.x);
    float moonCos = max(0.0, dot(p, uMoonDir));
    colour += vec3(0.42, 0.5, 0.72) * moonCos * uMoonLight * 0.05;
  }

  colour *= uExposure;

  // Tone map, then encode. Without this the limb clips to flat white exactly
  // where the scattering is most interesting.
  colour = colour / (colour + vec3(1.0));
  colour = pow(colour, vec3(1.0 / 2.2));

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
  float coverage = hitGround
    ? 1.0
    : clamp(max(length(scattered) * 320.0, glowPath * sunGone * 1.9), 0.0, 1.0);
  outColour = vec4(colour, coverage);
}`;
