/**
 * The real sky.
 *
 * Nine thousand stars from the Yale Bright Star Catalogue — every star visible
 * to the naked eye — placed by right ascension and declination, converted to
 * the observer's own horizon using local sidereal time, and drawn through the
 * same camera as the planet.
 *
 * So the constellations are the ones actually overhead. From Cape Town you get
 * the Southern Cross; from London you get the Plough. They rise and set through
 * the night because the sidereal time advances, and they are in the right place
 * relative to the sun because both come from the same clock.
 *
 * That is worth the 53kB. This product computes real solar geometry everywhere
 * else; a procedural scatter of dots behind it would be the one part of the sky
 * that was pretending.
 */

export const STAR_VERTEX = /* glsl */ `#version 300 es
precision highp float;

in float aRa;        // radians
in float aDec;       // radians
in float aMag;       // visual magnitude
in float aTemp;      // 0..1, log scale between 1800K and 40000K

uniform float uLst;          // local sidereal time, radians
uniform float uLatitude;     // radians
uniform float uFov;
uniform float uPitch;
uniform float uYaw;
uniform vec2  uResolution;
uniform float uCameraHeight;
uniform float uVisibility;   // 0..1, how much of the sky the sun has washed out
uniform float uPixelRatio;

out vec3  vColour;
out float vBrightness;
out float vSpike;    // how strongly this star shows diffraction spikes

const float R_PLANET = 6371000.0;

/* Blackbody colour, approximated over the range stars actually occupy.
   Real: O and B stars are blue-white, the sun is white, K and M are amber.
   A field of identical white dots is the clearest tell that a sky was
   generated rather than observed. */
vec3 blackbody(float t01) {
  float kelvin = exp(mix(log(1800.0), log(40000.0), t01));
  float x = clamp(kelvin, 1800.0, 40000.0) / 10000.0;
  vec3 c;
  c.r = clamp(1.30 - 0.28 * x, 0.55, 1.0);
  c.g = clamp(0.78 + 0.10 * x - 0.02 * x * x, 0.6, 1.0);
  c.b = clamp(0.55 + 0.55 * x, 0.5, 1.0);
  return c / max(c.r, max(c.g, c.b));
}

void main() {
  /* Equatorial to horizontal. The standard conversion, and the only place in
     this file where getting a sign wrong puts the whole sky in the wrong half
     of the world rather than merely somewhere odd. */
  float ha = uLst - aRa;
  float sinLat = sin(uLatitude), cosLat = cos(uLatitude);
  float sinDec = sin(aDec), cosDec = cos(aDec);

  float sinAlt = sinDec * sinLat + cosDec * cosLat * cos(ha);
  float alt = asin(clamp(sinAlt, -1.0, 1.0));
  float az = atan(-sin(ha) * cosDec, sinDec * cosLat - cosDec * sinLat * cos(ha));

  // Local frame: x east, y north, z up — the same one the planet shader uses.
  vec3 dir = vec3(cos(alt) * sin(az), cos(alt) * cos(az), sin(alt));

  /* Occlusion by the planet, done here rather than with a depth buffer.
     A star behind the Earth must not shine through it, and the planet is drawn
     as a full-screen quad with no depth to test against. One ray-sphere test
     per star is cheaper than a depth pass and exactly as correct. */
  vec3 origin = vec3(0.0, 0.0, R_PLANET + uCameraHeight);
  float b = dot(origin, dir);
  float c = dot(origin, origin) - R_PLANET * R_PLANET;
  float disc = b * b - c;
  bool blocked = disc > 0.0 && (-b - sqrt(disc)) > 0.0;

  // Undo the camera's yaw, then its pitch — the inverse of how the planet
  // shader builds a ray, so the two agree about where anything is.
  float cy = cos(uYaw), sy = sin(uYaw);
  vec3 unyawed = vec3(dir.x * cy - dir.y * sy, dir.x * sy + dir.y * cy, dir.z);
  float cp = cos(uPitch), sp = sin(uPitch);
  vec3 local = vec3(
    unyawed.x,
    unyawed.y * cp + unyawed.z * sp,
    -unyawed.y * sp + unyawed.z * cp
  );

  float aspect = uResolution.x / uResolution.y;
  float t = tan(uFov * 0.5);

  if (local.y <= 0.001 || blocked) {
    // Behind the camera or behind the planet: park it outside the clip volume.
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vBrightness = 0.0;
    vSpike = 0.0;
    vColour = vec3(0.0);
    return;
  }

  vec2 ndc = vec2(local.x / (local.y * t * aspect), local.z / (local.y * t));
  gl_Position = vec4(ndc, 0.0, 1.0);

  /* Flux, not magnitude. The scale is logarithmic and backwards — every five
     magnitudes is a hundredfold in light — so drawing size straight from the
     number would make Sirius and a barely-visible star nearly the same dot. */
  float flux = pow(10.0, -0.4 * (aMag - 1.0));

  /*
     Then STRETCHED, because a screen cannot hold the real range.
     Sirius is roughly two thousand times brighter than the faintest star here.
     Mapped linearly, either Sirius clips to a white blob or everything under
     fourth magnitude falls below one unit of eight-bit colour and the sky is
     empty. The 0.42 power is the same compression astrophotography applies for
     the same reason — it keeps the ordering while making the faint end visible.
  */
  vBrightness = clamp(pow(flux, 0.42) * 1.5, 0.0, 1.5) * uVisibility;

  /* Bright stars are drawn larger, which is how a camera records them too:
     the disc is the instrument's, not the star's. Square-rooted so the very
     brightest do not become blobs. */
  /* Minimum two pixels. A one-pixel point lands on a single fragment whose
     coverage depends on where the centre fell, so a field of them twinkles as
     the camera moves and vanishes at some sizes. Two is the smallest dot that
     renders consistently. */
  /*
     Only the bright ones get spikes, and that is how it works in reality.
     
     Diffraction spikes are an artefact of the instrument, not the star — light
     bending around the aperture. They appear on bright sources because the
     spike is orders of magnitude fainter than the core, so only a very bright
     core leaves a spike above the noise. Putting them on everything is the
     usual mistake and turns a sky into a sheet of asterisks.
  */
  vSpike = smoothstep(2.6, -0.5, aMag);

  /* Bright stars are drawn larger, which is how a camera records them too:
     the disc is the instrument's, not the star's. Square-rooted so the very
     brightest do not become blobs. Spiked stars need room for the spike. */
  gl_PointSize = clamp(2.0 + sqrt(flux) * 1.7 + vSpike * 7.0, 2.0, 15.0) * uPixelRatio;
  vColour = blackbody(aTemp);
}`;

export const STAR_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

in vec3  vColour;
in float vBrightness;
in float vSpike;
out vec4 outColour;

void main() {
  if (vBrightness <= 0.001) discard;

  /* A soft core with a wide faint skirt, rather than a disc.
     A hard-edged circle reads as a dot drawn on glass; the falloff is what
     makes it read as a point of light being recorded. */
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;

  float core = exp(-r2 * 6.5);
  float halo = exp(-r2 * 1.6) * 0.35;

  /*
     Four spikes, at right angles, thin and long.
     
     Their shape is not arbitrary: a spike runs perpendicular to each straight
     edge in the aperture, which is why a four-bladed instrument gives a cross
     and why every photograph of a bright star has one. Multiplied rather than
     added, so a spike is always fainter than the core it comes from — an
     additive spike survives after its own star has faded out, which looks like
     a defect because it is one.
  */
  float spikes = 0.0;
  if (vSpike > 0.0) {
    float horizontal = exp(-abs(d.y) * 34.0) * exp(-abs(d.x) * 1.6);
    float vertical   = exp(-abs(d.x) * 34.0) * exp(-abs(d.y) * 1.6);
    spikes = (horizontal + vertical) * vSpike * 0.55;
  }

  float intensity = (core + halo + spikes) * vBrightness;

  outColour = vec4(vColour * intensity, intensity);
}`;

export type StarField = {
  ra: Float32Array;
  dec: Float32Array;
  mag: Float32Array;
  temp: Float32Array;
  count: number;
};

/**
 * Decode the packed catalogue.
 *
 * Six bytes a star: right ascension and declination at sixteen bits each,
 * magnitude and colour temperature at eight. Sorted brightest first, so a
 * truncated read is still the best stars rather than an arbitrary slice.
 */
export function decodeStars(buffer: ArrayBuffer, limit?: number): StarField {
  const view = new DataView(buffer);
  const total = Math.floor(buffer.byteLength / 6);
  const count = limit ? Math.min(limit, total) : total;

  const ra = new Float32Array(count);
  const dec = new Float32Array(count);
  const mag = new Float32Array(count);
  const temp = new Float32Array(count);

  const DEG = Math.PI / 180;
  for (let i = 0; i < count; i++) {
    const o = i * 6;
    ra[i] = (view.getUint16(o, true) / 65535) * 360 * DEG;
    dec[i] = ((view.getUint16(o + 2, true) / 65535) * 180 - 90) * DEG;
    mag[i] = (view.getUint8(o + 4) / 255) * 10 - 2;
    temp[i] = view.getUint8(o + 5) / 255;
  }

  return { ra, dec, mag, temp, count };
}

/**
 * Local sidereal time, in radians.
 *
 * Sidereal time is the sky's own clock: it runs about four minutes a day faster
 * than the sun's, which is exactly why the constellations rise earlier each
 * night and why summer and winter have different skies. Without it the stars
 * would be pinned to the solar day and the whole sky would be wrong by hours
 * within a fortnight.
 *
 * Meeus' expression for Greenwich mean sidereal time, plus the observer's
 * longitude. Accurate to well under a second of arc over any span this will
 * ever be asked about — and far beyond what a star two pixels wide can show.
 */
export function localSiderealTime(at: Date, longitudeDeg: number): number {
  const jd = at.getTime() / 86_400_000 + 2_440_587.5;
  const d = jd - 2_451_545.0;
  const t = d / 36_525;

  let gmst =
    280.46061837 +
    360.98564736629 * d +
    0.000387933 * t * t -
    (t * t * t) / 38_710_000;

  gmst = ((gmst % 360) + 360) % 360;
  const lst = ((gmst + longitudeDeg) % 360 + 360) % 360;
  return (lst * Math.PI) / 180;
}
