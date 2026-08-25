import { FRAGMENT_SHADER, VERTEX_SHADER } from "./shaders";
import { decodeStars, localSiderealTime, STAR_FRAGMENT, STAR_VERTEX, type StarField } from "./stars";
import type { EnvironmentState } from "../model";
import { aimBody } from "../projection";
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
 * 5,500km, and the number is resolution rather than composition.
 *
 * At the ISS-like 620km this started from, the frame spanned about 7.8° of
 * longitude. An equirectangular texture 2048 pixels wide holds 2048 texels for
 * all 360°, so that is 44 texels stretched across a 1087-pixel frame —
 * **25× magnification**, which is exactly why the planet looked like a
 * low-resolution game asset. There was no detail there to show, at any texture
 * size that could reasonably be shipped.
 *
 * Height is the lever. Twice as far away is twice as much surface across the
 * same field of view, and therefore twice the texel density. At 5,500km the
 * frame spans about 68°, which against a 4096-wide texture is roughly 1.4×
 * magnification — near enough native that the limit becomes the source imagery
 * rather than the geometry.
 */
const CAMERA_HEIGHT_M = 5_500_000;

/** Vertical field of view. Wide, for the same reason the CSS scene's was. */
const FOV_RAD = (58 * Math.PI) / 180;

/**
 * How far the camera tilts down, putting the limb across the lower frame.
 *
 * Follows directly from the height, and has to be recomputed whenever that
 * changes. The planet's angular radius is `asin(R / (R + h))`, so its limb sits
 * `90° − that` below horizontal: 24° at 620km, but 57° at 5,500km. To leave the
 * limb about three-quarters of the way down a 58° frame, the camera pitches to
 * make up the difference.
 */
const PITCH_RAD = (-41 * Math.PI) / 180;

export type SceneQuality = "full" | "low";

const QUALITY = {
  full: { steps: 16, lightSteps: 6, scale: 1 },
  // Fewer samples and a smaller buffer, upscaled. The atmosphere is smooth, so
  // it survives resolution loss far better than the surface does.
  low: { steps: 8, lightSteps: 3, scale: 0.62 },
} as const;

/**
 * How many device pixels to render per CSS pixel.
 *
 * A canvas sized in CSS pixels on a display with `devicePixelRatio: 2` is
 * rendered at half the screen's resolution and scaled up by the browser —
 * every pixel becoming four. That is not a subtle softening; it is the whole
 * scene at 360p on a retina display, and it was the reason the Earth still
 * looked like a low-resolution image after the texture and the camera height
 * were both fixed.
 *
 * Capped at 2. Beyond that the fragment cost doubles again for a difference
 * nobody has ever been able to point to, and this shader is not cheap: every
 * pixel marches the atmosphere sixteen times, each of those sampling the light
 * path six more.
 */
const MAX_PIXEL_RATIO = 2;

type Textures = { day: WebGLTexture; night: WebGLTexture; clouds: WebGLTexture };

export class PlanetScene {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private textures: Textures | null = null;
  private quality: SceneQuality = "full";
  private reducedMotion = false;
  private disposed = false;

  /** The star pass: its own program, buffers and uniforms. */
  private starProgram: WebGLProgram | null = null;
  private starUniforms: Record<string, WebGLUniformLocation | null> = {};
  private starBuffers: WebGLBuffer[] = [];
  private starVao: WebGLVertexArrayObject | null = null;
  private starCount = 0;

  private constructor(
    private canvas: HTMLCanvasElement,
    gl: WebGL2RenderingContext,
    program: WebGLProgram
  ) {
    this.gl = gl;
    this.program = program;

    /**
     * Every uniform, and a complaint about any that did not resolve.
     *
     * `getUniformLocation` returns null for a name the linked program does not
     * have — a typo, a rename, or a uniform the compiler removed because
     * nothing read it. `gl.uniform1i(null, x)` is then a silent no-op, the
     * uniform keeps its default of zero, and the failure surfaces as a picture
     * that is subtly or completely wrong with nothing logged anywhere.
     *
     * That is not hypothetical here: `uSteps` at zero makes the scattering loop
     * break on its first iteration, so the atmosphere integrates to exactly
     * nothing and the sky renders black. Worth one loop at startup to never
     * wonder about again.
     */
    const missing: string[] = [];
    for (const name of [
      "uResolution", "uSunDir", "uMoonDir", "uMoonLight", "uMoonVisible", "uCameraHeight",
      "uSunDisplayDir", "uMoonDisplayDir", "uSunLimbProximity", "uSunIntensity",
      "uFov", "uPitch", "uYaw", "uEnuToEcef", "uExposure", "uSteps",
      "uLightSteps", "uCloudPhase", "uDay", "uNight", "uClouds",
    ]) {
      const location = gl.getUniformLocation(program, name);
      if (location === null) missing.push(name);
      this.uniforms[name] = location;
    }
    if (missing.length > 0) {
      console.warn("[scene] uniforms did not resolve, they will read as zero:", missing.join(", "));
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

    const scene = new PlanetScene(canvas, gl, program);
    scene.buildStarProgram();
    return scene;
  }

  /**
   * Load the three textures.
   *
   * Awaited before the first draw, and deliberately NOT awaited by anything on
   * the sign-in path — the form is interactive throughout, and until these
   * arrive the CSS scene is what is on screen. Roughly 900kB total, which is
   * why they are loaded after first paint rather than blocking it.
   */
  /**
   * Which texture set this device should carry.
   *
   * The 4K set is 2.8MB and the 2K set is 920KB, on a page that has to load
   * before anybody can do anything. A phone gains almost nothing from 4K — the
   * frame is a third the width — and a metered connection loses real money for
   * it, so `saveData` is honoured as the explicit request it is.
   */
  private static chooseSet(): "4k" | "2k" {
    if (typeof window === "undefined") return "2k";
    const connection = (navigator as { connection?: { saveData?: boolean } }).connection;
    if (connection?.saveData) return "2k";
    if (window.innerWidth < 900) return "2k";
    if (window.devicePixelRatio > 2.5 && window.innerWidth < 1400) return "2k";
    return "4k";
  }

  async loadTextures(base = "/scene"): Promise<boolean> {
    const set = PlanetScene.chooseSet();
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
        load(`earth-day-${set}.jpg`),
        load(`earth-night-${set}.jpg`),
        load(`earth-clouds-${set}.jpg`),
      ]);
      if (this.disposed) return false;
      this.textures = {
        day: this.upload(day, 0),
        night: this.upload(night, 1),
        clouds: this.upload(clouds, 2),
      };

      /**
       * Then, quietly, a much larger surface.
       *
       * At device resolution the frame is over two thousand pixels wide across
       * roughly 78° of longitude, which wants something like ten thousand
       * texels to be native. The 4K set is 2.5× short of that — visibly soft on
       * the one layer carrying recognisable detail.
       *
       * So the 8K surface is fetched AFTER the scene is already drawing, and
       * swapped in when it arrives. 2.8MB is far too much to wait for on a
       * login page; it is perfectly reasonable to arrive a few seconds later
       * and quietly sharpen a picture that was already complete. Only the
       * surface is upgraded — cloud is soft by nature and city lights are
       * points, so neither repays the bytes.
       */
      if (set === "4k") void this.upgrade(base);

      return true;
    } catch {
      // Offline, blocked, or a decode failure. The CSS scene stands.
      return false;
    }
  }

  /**
   * The extension that actually fixes grazing angles, if the driver has it.
   *
   * Without it the GPU picks one mip level from whichever axis is worse. Near
   * the limb the surface is compressed enormously in one direction and barely
   * at all in the other, so it selects a level appropriate for the compressed
   * axis and blurs the sharp one to match — the horizon goes soft precisely
   * where the eye is looking. Anisotropic filtering samples along the axis
   * instead of averaging across it.
   *
   * Read once and reused: querying an extension per texture is three lookups
   * for one answer.
   */
  private anisotropy: { ext: EXT_texture_filter_anisotropic; max: number } | null = null;

  /**
   * Sharper textures, in stages, once the scene is already drawing.
   *
   * ## Why there is a 16K tier at all
   *
   * Measured rather than assumed. Tracing the camera's own rays at 5,500km and
   * a 58° field: the planet occupies only the bottom fifth of the frame, and at
   * the BOTTOM EDGE — the nearest and largest part of it — an 8K surface
   * renders at **1.4 screen pixels per texel** on a 4K panel. That is
   * magnification. The shader was stretching each texel across more than one
   * pixel and there was no more detail in the file to show, which is exactly
   * what "looks like an old phone at 360p" is. 16K puts the same region at
   * roughly 2.8 texels per pixel — oversampled, which is where sharp lives.
   *
   * Every tier is a genuine downsample of a 21600-wide original, so this is
   * real detail arriving, not interpolation.
   *
   * ## And why the night texture upgrades too
   *
   * It was 4K while the day went to 8K, so the night side rendered at **half**
   * the day side's detail — 2.8 screen pixels per texel — and every coastal
   * city was smeared three pixels out into the water. That smear is what read
   * as "lights in the sea": the imagery has no light in the open ocean at all.
   *
   * ## Order and cost
   *
   * Night first at 4MB, then the surface at 9.4MB, sequentially rather than at
   * once — two large fetches racing each other finish later than either would
   * alone, and the first one to land is a visible improvement on its own.
   *
   * Failure at any point is silent and total: the scene keeps what it has,
   * which is a complete picture. Nothing waits on this and nothing reports it.
   */
  private async upgrade(base: string): Promise<void> {
    const connection = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } })
      .connection;
    if (connection?.saveData) return;
    // A slow link would spend a long time on this and arrive after the user has
    // signed in and gone.
    if (connection?.effectiveType && /2g|slow/.test(connection.effectiveType)) return;

    const fetchImage = (file: string, timeoutMs: number) =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        const timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
        img.onload = () => {
          clearTimeout(timer);
          resolve(img);
        };
        img.onerror = () => {
          clearTimeout(timer);
          reject(new Error("failed"));
        };
        img.src = `${base}/${file}`;
      });

    const swap = (key: "day" | "night", image: TexImageSource, unit: number) => {
      if (this.disposed || !this.textures) return;
      const previous = this.textures[key];
      this.textures = { ...this.textures, [key]: this.upload(image, unit) };
      this.gl.deleteTexture(previous);
      this.onUpgrade?.();
    };

    try {
      swap("night", await fetchImage("earth-night-8k.jpg", 30_000), 1);
    } catch {
      // The 4K night stands.
    }

    /*
       The top surface tier is desktop-only, and gated on more than the
       connection: 9.4MB is a real cost, and a 1280-wide window renders the
       foreground at 2.5 texels per pixel against the 8K texture already. It
       buys nothing there. `deviceMemory` is advisory and absent on Safari,
       so it only ever excludes — never a requirement.
    */
    /*
       The GPU has to be able to hold it, and many cannot.

       16384 is the largest size WebGL2 guarantees nothing about: this machine
       reports exactly 16384, which is the common desktop ceiling, while plenty
       of integrated and mobile GPUs report 8192 or 4096. Uploading past the
       limit fails with INVALID_VALUE and leaves a black surface where a
       perfectly good 8K one was — after spending 9.4MB to get there. Asking
       first costs one parameter read.
    */
    if (this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) < 16384) return;

    /*
       DEVICE pixels, not CSS pixels — and this was a real miss.

       The first version gated on `innerWidth < 1400`, which excluded a 1035px
       window sitting beside an editor. That window has a drawing buffer of
       2070 x 2290: over four megapixels, rendering the foreground of the frame
       at well under one texel per pixel against the 8K surface. It is exactly
       the case that needs the larger texture, and the check turned it away.

       CSS pixels say how big the window looks. Device pixels say how many
       samples the shader has to fill, which is the only thing texture
       resolution answers to.
    */
    const memory = (navigator as { deviceMemory?: number }).deviceMemory;
    const devicePixels =
      window.innerWidth * Math.min(MAX_PIXEL_RATIO, window.devicePixelRatio || 1);
    if (devicePixels < 1800) return;
    if (typeof memory === "number" && memory < 8) return;

    try {
      const image = await this.fetchWithBudget(`${base}/earth-day-16k.jpg`, 25_000);
      if (image) swap("day", image, 0);
    } catch {
      // The 8K surface stands.
    }
  }

  /**
   * Fetch a large texture, and genuinely give up if it takes too long.
   *
   * ## Measuring beats predicting
   *
   * The gate here used to be `connection.effectiveType`, and it was quietly
   * wrong. That value is a coarse, quantised ESTIMATE: it reported "3g" for a
   * localhost connection with no network involved at all, and vetoed the
   * upgrade on a machine that would have finished the download instantly.
   * Refusing to try, based on a guess about a connection, is strictly worse
   * than trying and stopping.
   *
   * So the request carries an `AbortController` and a budget. If 9.4MB has not
   * arrived in twenty-five seconds it is genuinely CANCELLED — not merely
   * ignored, which is all a timeout wrapped around `Image.src` can do. That
   * distinction is the point: an abandoned image request goes on consuming a
   * slow connection in the background, competing with the sign-in the person is
   * actually trying to complete.
   *
   * `saveData` is still honoured earlier and unconditionally, because that is a
   * person saying no, which no measurement overrides.
   */
  private async fetchWithBudget(url: string, budgetMs: number): Promise<ImageBitmap | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) return null;
      const blob = await response.blob();
      if (this.disposed) return null;
      /* Decoded off the main thread, which matters at this size: a
         16384 x 8192 JPEG decoded synchronously is a visible stall on the very
         thread the password is being typed into. */
      return await createImageBitmap(blob);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Called when a texture is swapped, so the scene can redraw immediately. */
  onUpgrade: (() => void) | null = null;

  private upload(image: TexImageSource, unit: number): WebGLTexture {
    const gl = this.gl;

    if (this.anisotropy === null) {
      const ext = gl.getExtension("EXT_texture_filter_anisotropic");
      this.anisotropy = ext
        ? { ext, max: gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number }
        : ({ ext: null, max: 0 } as never);
    }
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

    const aniso = this.anisotropy;
    if (aniso?.ext) {
      /* Whatever the driver offers, up to 16. The incidence angle across the
         visible part of this planet runs from about 40° to 90° — at the limb
         the surface is edge-on — so the ratio between the two axes is large
         and this is the one setting that addresses it directly. */
      gl.texParameterf(
        gl.TEXTURE_2D,
        aniso.ext.TEXTURE_MAX_ANISOTROPY_EXT,
        Math.min(16, aniso.max)
      );
    }

    gl.generateMipmap(gl.TEXTURE_2D);
    return texture;
  }

  /** The second program. Failing to build it costs the stars, not the scene. */
  private buildStarProgram(): void {
    const gl = this.gl;
    const program = link(gl, STAR_VERTEX, STAR_FRAGMENT);
    if (!program) return;
    this.starProgram = program;
    for (const name of [
      "uLst", "uLatitude", "uFov", "uPitch", "uYaw",
      "uResolution", "uCameraHeight", "uVisibility", "uPixelRatio",
    ]) {
      this.starUniforms[name] = gl.getUniformLocation(program, name);
    }
  }

  /**
   * Load the catalogue and hand it to the GPU.
   *
   * Separate from the textures and separately survivable: a sky without stars
   * is a worse sky, a scene that failed to start is no scene at all.
   */
  async loadStars(url = "/scene/stars.bin"): Promise<boolean> {
    if (!this.starProgram) return false;
    try {
      const response = await fetch(url);
      if (!response.ok) return false;
      const stars = decodeStars(await response.arrayBuffer());
      if (this.disposed) return false;
      this.uploadStars(stars);
      return true;
    } catch {
      return false;
    }
  }

  private uploadStars(stars: StarField): void {
    const gl = this.gl;
    const program = this.starProgram!;

    this.starVao = gl.createVertexArray();
    gl.bindVertexArray(this.starVao);

    const attach = (name: string, data: Float32Array) => {
      const buffer = gl.createBuffer()!;
      this.starBuffers.push(buffer);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      const location = gl.getAttribLocation(program, name);
      if (location >= 0) {
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, 1, gl.FLOAT, false, 0, 0);
      }
    };

    attach("aRa", stars.ra);
    attach("aDec", stars.dec);
    attach("aMag", stars.mag);
    attach("aTemp", stars.temp);

    gl.bindVertexArray(null);
    this.starCount = stars.count;
  }

  setQuality(quality: SceneQuality): void {
    this.quality = quality;
  }

  /** Holds the weather still. See the note where the phase is computed. */
  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
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

    const dpr = Math.min(MAX_PIXEL_RATIO, typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * scale * dpr));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * scale * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    /*
       Stars FIRST, planet over the top.
       They are the furthest thing in the scene, and drawing them first means
       the atmosphere — which has partial coverage near the limb — genuinely
       dims the ones behind it, and the planet blots out the ones behind IT.
       Drawn afterwards they would shine through the Earth.
    */
    this.renderStars(state, sun, where, width, height, facingDeg);

    gl.useProgram(this.program);

    const u = this.uniforms;
    gl.uniform2f(u.uResolution, width, height);
    gl.uniform3fv(u.uSunDir, localDirection(sun.altitudeDeg, sun.azimuthDeg));
    gl.uniform3fv(u.uMoonDir, localDirection(moon.altitudeDeg, moon.azimuthDeg));
    gl.uniform1f(u.uMoonLight, state.moonlight * 6);
    /* Whether the moon is UP, which is a different question from how much light
       it casts. A thin crescent lights nothing and is still plainly visible, so
       the disc is gated on this and the ground wash on `uMoonLight`. */
    gl.uniform1f(u.uMoonVisible, state.moonVisible);

    /*
       Where the discs are DRAWN, which is not where the light comes from.

       Against the shader's real 58°x52° camera the sun is on screen 0.0% of the
       day — measured over a full day at Cape Town it is within the frame's
       bearing 13.9% of the time and within its altitude 1.4%, never both. The
       CSS scene had been hiding that behind a 220° projection folding the whole
       sky into the frame, so moving the disc into the shader made it disappear
       entirely.

       `uSunDir` above still lights the planet from the true solar vector. Only
       the placement is artistic, and the two properties that carry the moment
       both survive it: the limb sits at the same altitude in every direction,
       so compressing azimuth cannot change when a body crosses it, and both
       occlusion and reddening are computed from each pixel's own ray.
    */
    const horizontalFovDeg = (FOV_RAD * 180) / Math.PI * (width / height);
    const sunAim = aimBody(sun.altitudeDeg, sun.azimuthDeg, facingDeg, horizontalFovDeg);
    const moonAim = aimBody(moon.altitudeDeg, moon.azimuthDeg, facingDeg, horizontalFovDeg);
    gl.uniform3fv(u.uSunDisplayDir, new Float32Array(sunAim.direction));
    gl.uniform3fv(u.uMoonDisplayDir, new Float32Array(moonAim.direction));
    gl.uniform1f(u.uSunLimbProximity, sunAim.limbProximity);
    /* `sunIntensity`, not `sunVisible`: the halo has to outlive the disc. See
       the uniform's own note in the shader. */
    gl.uniform1f(u.uSunIntensity, state.sunIntensity);

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
    /*
       Weather's own clock, read from the hour and the minute.

       The phase is a function of clock TIME rather than of elapsed frames, so
       the clouds are where the hour says they are: reproducible, the same on
       every device looking at the same moment, and continuous across a reload
       instead of snapping back to wherever the page started.

       ## The rate

       A lap every two hours. That works out at three degrees of longitude a
       minute, and across a 68° frame on a 1100-pixel-wide screen it is a little
       under one pixel per second.

       The first version wrapped in twenty minutes, which is six times that —
       about five pixels a second. Five pixels a second is above the threshold
       where ambient movement stops being ambient: the eye locks on and tracks
       it, and on a page somebody is trying to read a password field on, that is
       a real cost rather than a flourish. Below roughly a pixel a second the
       motion registers only if you go looking for it, which is where drift
       belongs.

       Two hours also divides the day cleanly, so the pattern repeats on a whole
       hour rather than at some arbitrary offset from an epoch nobody chose.
    */
    const CLOUD_LAP_HOURS = 2;
    const at = new Date(sun.timestamp);
    const hoursIntoLap =
      (at.getUTCHours() % CLOUD_LAP_HOURS) +
      at.getUTCMinutes() / 60 +
      at.getUTCSeconds() / 3600 +
      at.getUTCMilliseconds() / 3_600_000;
    const phase = this.reducedMotion ? 0 : hoursIntoLap / CLOUD_LAP_HOURS;
    gl.uniform1f(u.uCloudPhase, phase);

    gl.uniform1i(u.uSteps, steps);
    gl.uniform1i(u.uLightSteps, lightSteps);
    gl.uniform1i(u.uDay, 0);
    gl.uniform1i(u.uNight, 1);
    gl.uniform1i(u.uClouds, 2);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private renderStars(
    state: EnvironmentState,
    sun: SolarSnapshot,
    where: Coordinates,
    width: number,
    height: number,
    facingDeg: number
  ): void {
    if (!this.starProgram || this.starCount === 0) return;
    const gl = this.gl;

    gl.useProgram(this.starProgram);
    gl.bindVertexArray(this.starVao);
    /*
       Additive, and `ONE` for the source rather than `SRC_ALPHA`.
       Overlapping stars in a dense field should build up rather than replace
       one another — that is what makes a crowded region read as a glow instead
       of a heap of separate dots.

       The source factor matters more than it looks. With `SRC_ALPHA` the colour
       is multiplied by alpha at blend time, and the fragment shader has already
       multiplied by intensity — so brightness came out SQUARED, and a sixth
       magnitude star landed at about one part in sixty thousand. The whole
       catalogue drew, correctly positioned and correctly occluded, and was
       invisible. Pre-multiplied by intensity in the shader, added with `ONE`
       here: scaled exactly once.
    */
    gl.blendFunc(gl.ONE, gl.ONE);

    const u = this.starUniforms;
    gl.uniform1f(u.uLst, localSiderealTime(new Date(sun.timestamp), where.longitude));
    gl.uniform1f(u.uLatitude, (where.latitude * Math.PI) / 180);
    gl.uniform1f(u.uFov, FOV_RAD);
    gl.uniform1f(u.uPitch, PITCH_RAD);
    gl.uniform1f(u.uYaw, (facingDeg * Math.PI) / 180);
    gl.uniform2f(u.uResolution, width, height);
    gl.uniform1f(u.uCameraHeight, CAMERA_HEIGHT_M);
    gl.uniform1f(u.uVisibility, state.starVisibility);
    gl.uniform1f(u.uPixelRatio, Math.min(2, width / Math.max(1, this.canvas.clientWidth)));

    gl.drawArrays(gl.POINTS, 0, this.starCount);

    gl.bindVertexArray(null);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  dispose(): void {
    this.disposed = true;
    const gl = this.gl;
    for (const buffer of this.starBuffers) gl.deleteBuffer(buffer);
    this.starBuffers = [];
    if (this.starVao) gl.deleteVertexArray(this.starVao);
    if (this.starProgram) gl.deleteProgram(this.starProgram);
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
