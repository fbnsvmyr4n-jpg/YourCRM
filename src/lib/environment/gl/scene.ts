import { FRAGMENT_SHADER, VERTEX_SHADER } from "./shaders";
import type { EnvironmentState } from "../model";
import type { Coordinates, MoonSnapshot, SolarSnapshot } from "../../solar/types";

/**
 * The WebGL planet, driven by the same environment state as everything else.
 *
 * **It renders on demand, not on a loop of its own.** §11 asks for one clock,
 * and this obeys it: `render()` is called from the clock's publish, so the
 * planet, the sky and the card always describe the same instant. It also means
 * the scene draws in a throttled tab, where a private `requestAnimationFrame`
 * would simply stop.
 *
 * Everything degrades. No WebGL2, no textures, a lost context, a device that
 * cannot keep up — each returns to the CSS scene, which is a complete picture
 * on its own rather than a placeholder. Nothing here can prevent a sign-in.
 */

/**
 * How far above the surface the camera sits.
 *
 * 620km, a little above the ISS. The number is chosen for the curve: lower and
 * the horizon flattens into a line, higher and the planet shrinks into a ball
 * with space around it. This is the altitude at which the limb reads as a world
 * curving away, which is the whole vantage.
 */
const CAMERA_HEIGHT_M = 620_000;

/** Vertical field of view. Wide, for the same reason the CSS scene's was. */
const FOV_RAD = (58 * Math.PI) / 180;

/**
 * How far the camera tilts down, putting the limb across the lower frame.
 *
 * Very little, and that is geometry rather than taste. At 620km the horizon
 * already sits 24° below horizontal — `acos(R / (R + h))` — so a camera looking
 * straight ahead puts the limb near the bottom of a 58° frame all by itself.
 * The first value here was −19°, which pitched down almost to the horizon and
 * filled half the picture with planet.
 */
const PITCH_RAD = (-4 * Math.PI) / 180;

export type SceneQuality = "full" | "low";

const QUALITY = {
  full: { steps: 16, lightSteps: 6, scale: 1 },
  // Fewer samples and a smaller buffer, upscaled. The atmosphere is smooth, so
  // it survives resolution loss far better than the surface does.
  low: { steps: 8, lightSteps: 3, scale: 0.6 },
} as const;

type Textures = { day: WebGLTexture; night: WebGLTexture; clouds: WebGLTexture };

export class PlanetScene {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private textures: Textures | null = null;
  private quality: SceneQuality = "full";
  private disposed = false;

  private constructor(
    private canvas: HTMLCanvasElement,
    gl: WebGL2RenderingContext,
    program: WebGLProgram
  ) {
    this.gl = gl;
    this.program = program;

    for (const name of [
      "uResolution", "uSunDir", "uMoonDir", "uMoonLight", "uCameraHeight",
      "uFov", "uPitch", "uYaw", "uEnuToEcef", "uExposure", "uSteps",
      "uLightSteps", "uDay", "uNight", "uClouds",
    ]) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }
  }

  /**
   * Build the scene, or return null.
   *
   * Null is an ordinary outcome, not an error: WebGL2 is absent on old
   * hardware and disabled by some privacy settings, and the CSS scene is a
   * complete picture. Nothing is logged loudly and nothing is thrown.
   */
  static create(canvas: HTMLCanvasElement): PlanetScene | null {
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false, // The shader has no geometry edges to alias.
      premultipliedAlpha: false,
      powerPreference: "low-power",
    });
    if (!gl) return null;

    const program = link(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    if (!program) return null;

    // One full-screen triangle pair. The only geometry in the entire scene.
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW
    );
    const position = gl.getAttribLocation(program, "aPosition");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    return new PlanetScene(canvas, gl, program);
  }

  /**
   * Load the three textures.
   *
   * Awaited before the first draw, and deliberately NOT awaited by anything on
   * the sign-in path — the form is interactive throughout, and until these
   * arrive the CSS scene is what is on screen. Roughly 900kB total, which is
   * why they are loaded after first paint rather than blocking it.
   */
  async loadTextures(base = "/scene"): Promise<boolean> {
    /**
     * `onload`, not `decode()`.
     *
     * `HTMLImageElement.decode()` is the tidier API and it **never resolves in
     * a hidden tab** — browsers defer decoding for pages nobody is looking at,
     * and the promise simply hangs. Anyone opening the login page in a
     * background tab would have waited for a planet that never arrived, and the
     * promise itself would never have settled to say so.
     *
     * `onload` fires on the bytes arriving, which happens regardless of
     * visibility. The decode then falls to `texImage2D`, at upload, when the
     * page is being drawn anyway.
     *
     * The timeout is the third case: a request that neither loads nor errors,
     * which a captive portal or a stalled connection produces. Ten seconds and
     * the CSS scene keeps the screen.
     */
    const load = (file: string) =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        const timer = setTimeout(() => reject(new Error(`timed out: ${file}`)), 10_000);
        image.onload = () => {
          clearTimeout(timer);
          resolve(image);
        };
        image.onerror = () => {
          clearTimeout(timer);
          reject(new Error(`failed: ${file}`));
        };
        image.src = `${base}/${file}`;
      });

    try {
      const [day, night, clouds] = await Promise.all([
        load("earth-day.jpg"),
        load("earth-night.jpg"),
        load("earth-clouds.jpg"),
      ]);
      if (this.disposed) return false;
      this.textures = {
        day: this.upload(day, 0),
        night: this.upload(night, 1),
        clouds: this.upload(clouds, 2),
      };
      return true;
    } catch {
      // Offline, blocked, or a decode failure. The CSS scene stands.
      return false;
    }
  }

  private upload(image: HTMLImageElement, unit: number): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);
    /* Wrap in longitude, clamp in latitude. Wrapping vertically would smear
       Antarctica across the Arctic at the poles; wrapping horizontally is
       required, because longitude genuinely is a circle. */
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
    return texture;
  }

  setQuality(quality: SceneQuality): void {
    this.quality = quality;
  }

  get ready(): boolean {
    return this.textures !== null && !this.disposed;
  }

  /**
   * Draw one frame.
   *
   * Takes the solar snapshot rather than only the environment state, because
   * the shader needs the sun's actual direction — altitude and azimuth — not
   * the derived light values. The two describe the same instant; this is the
   * layer that needs the geometry rather than the interpretation.
   */
  render(
    state: EnvironmentState,
    sun: SolarSnapshot,
    moon: MoonSnapshot,
    where: Coordinates,
    facingDeg: number
  ): void {
    if (this.disposed || !this.textures) return;
    const gl = this.gl;
    const { steps, lightSteps, scale } = QUALITY[this.quality];

    const width = Math.max(1, Math.round(this.canvas.clientWidth * scale));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * scale));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);

    const u = this.uniforms;
    gl.uniform2f(u.uResolution, width, height);
    gl.uniform3fv(u.uSunDir, localDirection(sun.altitudeDeg, sun.azimuthDeg));
    gl.uniform3fv(u.uMoonDir, localDirection(moon.altitudeDeg, moon.azimuthDeg));
    gl.uniform1f(u.uMoonLight, state.moonlight * 6);
    gl.uniform1f(u.uCameraHeight, CAMERA_HEIGHT_M);
    gl.uniform1f(u.uFov, FOV_RAD);
    gl.uniform1f(u.uPitch, PITCH_RAD);
    gl.uniform1f(u.uYaw, (facingDeg * Math.PI) / 180);
    gl.uniformMatrix3fv(u.uEnuToEcef, false, enuToEcef(where));
    /*
       Exposure is FLAT, and that is the correction rather than the original
       plan. Lifting the night side by 0.9 to "make it visible" amplified the
       one thing that should have been black: the gamma curve at the end of the
       shader turns a linear 0.02 into a 0.25 mid-grey, so a trace of scattered
       light from the far limb — physically real, physically negligible — was
       rendering the whole night side as dusk.

       Night is carried by city lights and moonlight, both of which are
       genuinely emissive, rather than by turning up the gain on nothing.
    */
    gl.uniform1f(u.uExposure, 1.0);
    gl.uniform1i(u.uSteps, steps);
    gl.uniform1i(u.uLightSteps, lightSteps);
    gl.uniform1i(u.uDay, 0);
    gl.uniform1i(u.uNight, 1);
    gl.uniform1i(u.uClouds, 2);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    this.disposed = true;
    const gl = this.gl;
    if (this.textures) {
      for (const texture of Object.values(this.textures)) gl.deleteTexture(texture);
      this.textures = null;
    }
    gl.deleteProgram(this.program);
  }
}

/**
 * A body's direction in the observer's local frame, from horizontal coordinates.
 *
 * x east, y north, z up — and azimuth is a compass bearing from north, which is
 * what the solar wrapper measured rather than what its documentation claimed.
 */
function localDirection(altitudeDeg: number, azimuthDeg: number): Float32Array {
  const alt = (altitudeDeg * Math.PI) / 180;
  const az = (azimuthDeg * Math.PI) / 180;
  const cos = Math.cos(alt);
  return new Float32Array([cos * Math.sin(az), cos * Math.cos(az), Math.sin(alt)]);
}

/**
 * The rotation taking the observer's local frame into earth-fixed coordinates.
 *
 * Needed only to ask "which part of the map is under this pixel". Columns are
 * the east, north and up vectors expressed in ECEF, and WebGL wants column
 * order, which is the same thing written down — a transposition here would put
 * the user somewhere plausible and wrong, which is the hardest kind to notice.
 */
function enuToEcef(where: Coordinates): Float32Array {
  const lat = (where.latitude * Math.PI) / 180;
  const lon = (where.longitude * Math.PI) / 180;
  const sLat = Math.sin(lat), cLat = Math.cos(lat);
  const sLon = Math.sin(lon), cLon = Math.cos(lon);

  return new Float32Array([
    -sLon, cLon, 0,                              // east
    -sLat * cLon, -sLat * sLon, cLat,            // north
    cLat * cLon, cLat * sLon, sLat,              // up
  ]);
}

function link(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram | null {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      // Kept, because a shader that fails to compile in one driver and not
      // another is otherwise invisible — the scene simply does not appear.
      console.warn("[scene] shader failed:", gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  };

  const vs = compile(gl.VERTEX_SHADER, vertex);
  const fs = compile(gl.FRAGMENT_SHADER, fragment);
  if (!vs || !fs) return null;

  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn("[scene] link failed:", gl.getProgramInfoLog(program));
    return null;
  }
  return program;
}
