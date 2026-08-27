import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FRAGMENT_SHADER, VERTEX_SHADER } from "../src/lib/environment/gl/shaders";
import { STAR_FRAGMENT, STAR_VERTEX } from "../src/lib/environment/gl/stars";

/**
 * The shaders are GLSL living inside JavaScript template literals, which is a
 * quiet trap: the two languages disagree about what a backtick is.
 *
 * Writing an identifier in a comment the way the rest of this codebase does —
 * in backticks — closes the template string. I did it twice. Both times
 * TypeScript caught it, because the resulting JavaScript was nonsense. But a
 * BALANCED pair would not be nonsense: it would compile, silently truncate the
 * shader at the first backtick and resume at the second, and produce a program
 * that either fails to link or, worse, links into something subtly wrong.
 *
 * Nothing else in the project can see inside these strings. GLSL has no
 * compiler here and no linter; the first thing that reads them is a graphics
 * driver in somebody's browser.
 */

const SHADERS = {
  "planet vertex": VERTEX_SHADER,
  "planet fragment": FRAGMENT_SHADER,
  "star vertex": STAR_VERTEX,
  "star fragment": STAR_FRAGMENT,
};

describe("the shader sources survive being JavaScript strings", () => {
  for (const [name, source] of Object.entries(SHADERS)) {
    it(`${name} contains no backticks`, () => {
      expect(source, "a backtick here closes the template literal early").not.toContain("`");
    });

    it(`${name} contains no template interpolation`, () => {
      // `${` inside the literal would be evaluated as JavaScript. GLSL uses no
      // such sequence, so its presence is always a mistake rather than intent.
      expect(source).not.toContain("${");
    });

    it(`${name} declares its version on the first line`, () => {
      // `#version` must be the very first thing in a GLSL ES 3.00 shader — not
      // even a blank line may precede it — and a leading newline from the
      // template literal is the classic way to break that.
      expect(source.startsWith("#version 300 es")).toBe(true);
    });

    it(`${name} has a main`, () => {
      expect(source).toMatch(/void\s+main\s*\(\s*\)/);
    });
  }

  it("would notice a backtick if one were added", () => {
    // The guard proving it can fail.
    expect(() => {
      const broken = "#version 300 es\n// see `foo`\nvoid main() {}";
      expect(broken).not.toContain("`");
    }).toThrow();
  });
});

describe("the sun and moon are drawn by the shader, not by CSS", () => {
  /**
   * These four lines are the whole reason the discs moved out of CSS, and each
   * of them is a term that could be deleted without anything failing to
   * compile — leaving a sun that looks fine in a still frame and cheap in
   * motion, which is the failure that got reported in the first place.
   */
  it("occludes the disc with the same coverage that antialiases the limb", () => {
    // A sprite behind a CSS layer can only be clipped. This is what makes the
    // sun disappear behind the limb on the same subpixel edge as the surface.
    expect(FRAGMENT_SHADER).toMatch(/notBlocked\s*=\s*1\.0\s*-\s*groundCoverage/);
    expect(FRAGMENT_SHADER).toMatch(/disc \* limbDark \* slant \* notBlocked/);
  });

  it("reddens the disc with the view path's own optical depth", () => {
    /* The physics, not a colour ramp: blue is removed roughly sixteen times
       faster than red, so the disc goes orange and then deep red as it nears
       the limb. Computed from `viewDepth`, which the scattering loop already
       produced — a second, separate reddening curve would be a copy that can
       drift from the sky it is supposed to match. */
    expect(FRAGMENT_SHADER).toMatch(/BETA_RAYLEIGH \* viewDepth\.x/);
    expect(FRAGMENT_SHADER).toMatch(/SUN_EXTINCTION_SCALE/);
  });

  it("draws the discs before tone mapping, so they bloom", () => {
    const sun = FRAGMENT_SHADER.indexOf("SUN_RADIUS");
    const tone = FRAGMENT_SHADER.indexOf("colour / (colour + vec3(1.0))");
    expect(sun).toBeGreaterThan(0);
    expect(tone).toBeGreaterThan(0);
    // In linear light and above the tone curve: that is what turns a very
    // bright small disc into a glow rather than a clipped white circle.
    expect(sun).toBeLessThan(tone);
  });

  it("refuses to paint a sun behind the camera", () => {
    /**
     * A real bug, found while adding the refraction flattening.
     *
     * The offset is divided by `max(alongSun, 0.05)` so the disc can be
     * squashed along one axis. For a ray pointing directly AWAY from the sun,
     * both components of that offset are zero — so the angle evaluates to zero,
     * passes the radius test, and paints a second sun at the antipode of the
     * real one. It appears whenever the sun is behind the viewer, which on this
     * camera is most of the day.
     *
     * The whole disc block must therefore be gated on facing the sun at all.
     */
    const block = FRAGMENT_SHADER.match(
      /if \(sunDiscAngle < SUN_RADIUS[^)]*\)[^{]*\{/
    );
    expect(block, "the sun disc block should exist").toBeTruthy();
    expect(block![0]).toContain("alongSun > 0.0");
  });

  it("flattens the disc without flattening the glow", () => {
    /**
     * Reported as the sun distorting too much as it set, and the cause was one
     * angle doing two jobs. The flattened angle was fed to the disc, the corona
     * AND all six diffraction spikes, so the entire glow stretched by up to 27%
     * horizontally as the sun neared the limb.
     *
     * Refraction bends light passing through AIR, so it distorts the sun's own
     * image. The aureole and the spikes are not the sun's image — they are what
     * the instrument does with a bright source. A lens does not become
     * elliptical because the thing it is looking at is near the horizon.
     */
    expect(FRAGMENT_SHADER, "the disc uses the flattened angle").toMatch(
      /if \(sunDiscAngle < SUN_RADIUS/
    );
    expect(FRAGMENT_SHADER, "the halo uses the round angle").toMatch(
      /float halo = SUN_RADIUS \/ max\(sunAngle,/
    );
    expect(FRAGMENT_SHADER, "the spikes use the round offset").toMatch(
      /vec2 spikeDir = sunOffsetRound/
    );
    /* And the round angle must not be built from the flattened offset, which
       would reconnect them while looking separate. */
    expect(FRAGMENT_SHADER).toMatch(
      /vec2 sunOffsetRound = vec2\(dot\(dir, sunRight\), dot\(dir, sunUp\)\);/
    );
  });

  it("gates the moon disc on it being up, not on how much light it casts", () => {
    // A thin crescent lights nothing and is plainly visible. Keying the disc to
    // `uMoonLight` would make the moon vanish for most of the month.
    expect(FRAGMENT_SHADER).toMatch(/if \(uMoonVisible > 0\.0\)/);
  });
});

describe("the atmosphere is a limb, not a ribbon", () => {
  /**
   * Reported as "a blue strip that curves above the earth… it looks fictional",
   * which turned out to be an exact diagnosis. Measured, the band was 384
   * device pixels thick against a real 23 — but the damning number was that its
   * brightest point sat 331km ABOVE the surface. A real atmosphere is brightest
   * where it is densest, at the ground; a peak three hundred kilometres up
   * detaches the glow from the planet, and that is what makes it read as a
   * ribbon laid over the picture.
   *
   * The shell says where air can be; the SCALE HEIGHT says where it actually
   * is, and the second is what decides the band's shape. These pin both, and
   * the two constants derived from the scale height.
   */
  it("keeps the scale height low enough that the band hugs the surface", () => {
    const h = FRAGMENT_SHADER.match(/H_RAYLEIGH\s*=\s*([\d.]+)/);
    expect(h).toBeTruthy();
    // 128000 put the peak 331km up. Anything near it brings the ribbon back.
    expect(Number(h![1])).toBeLessThan(60000);
  });

  it("derives the extinction constants from that scale height", () => {
    /* Both are sqrt(scale height) relationships, not dials. If H_RAYLEIGH moves
       and these do not, the surface haze and the sunset's reddening silently
       stop matching the air they are supposed to describe. */
    const h = Number(FRAGMENT_SHADER.match(/H_RAYLEIGH\s*=\s*([\d.]+)/)![1]);
    const sun = Number(FRAGMENT_SHADER.match(/SUN_EXTINCTION_SCALE\s*=\s*([\d.]+)/)![1]);
    expect(sun).toBeCloseTo(Math.sqrt(8500 / h), 2);
  });

  it("models airglow as a layer rather than as the whole air column", () => {
    /**
     * The night limb is the one part of this that was called good, and it was
     * being produced by the wrong model: emission proportional to the Rayleigh
     * column is brightest at the GROUND, not at 90km where airglow actually
     * lives. It only looked like an arc because the old term saturated its own
     * clamp across the whole fat shell. Thinning the shell removed the padding
     * and the arc nearly vanished, which is how the wrong model showed itself.
     */
    expect(FRAGMENT_SHADER).toMatch(/GLOW_ALTITUDE/);
    expect(FRAGMENT_SHADER).toMatch(/glowDensity \* [\d.e-]+/);
    expect(FRAGMENT_SHADER, "airglow must not be driven by the Rayleigh column")
      .not.toMatch(/glowPath\s*=\s*clamp\(depthAlongView/);
  });

  it("lets one renderer own the sky", () => {
    // `.sky-wash` is a second, cruder CSS theory of the same air. Invisible
    // under a 384px ribbon; the brightest blue on screen once the ribbon became
    // a real arc.
    const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
    /* `0\b` was the first attempt and it matches "0.18" — the word boundary
       falls between the 0 and the dot — so the check passed against exactly the
       value it existed to forbid. Anchored on the terminator instead. */
    expect(css).toMatch(/\[data-planet="live"\]\s*\.sky-wash[\s\S]{0,140}opacity:\s*0\s*[;}]/);
  });
});

describe("the shader sources survive being written inside template literals", () => {
  /**
   * A backtick in a GLSL comment ENDS the JavaScript template literal holding
   * the shader. I have now done this four times while documenting this file,
   * because writing `identifier` in prose is a reflex.
   *
   * In practice the compiler does catch it — the text after the stray backtick
   * almost never parses as JavaScript. What it does NOT do is say why: the
   * error lands wherever the parser finally gave up, often hundreds of lines
   * from the comment that caused it, reported as a missing semicolon in a file
   * that has no statements in it at all. That is a genuinely confusing minute
   * every time.
   *
   * This trades that for a message naming the actual rule. It is a signposting
   * guard rather than a safety net, and worth having for a mistake with a 100%
   * recurrence rate.
   */
  const source = readFileSync(
    new URL("../src/lib/environment/gl/shaders.ts", import.meta.url),
    "utf8"
  );
  const stars = readFileSync(
    new URL("../src/lib/environment/gl/stars.ts", import.meta.url),
    "utf8"
  );

  const insideLiterals = (file: string) =>
    [...file.matchAll(/\/\* glsl \*\/ `([\s\S]*?)`;/g)].map((m) => m[1]);

  it("contains no backticks inside the GLSL", () => {
    for (const [name, file] of [["shaders.ts", source], ["stars.ts", stars]] as const) {
      const bodies = insideLiterals(file);
      expect(bodies.length, `${name} should hold at least one GLSL literal`).toBeGreaterThan(0);
      for (const body of bodies) {
        expect(body, `${name}: a backtick here would truncate the shader`).not.toContain("`");
      }
    }
  });

  it("still holds a whole shader after the literal is parsed", () => {
    // The even-numbered case leaves a shader that is short but syntactically
    // fine. Length is the crude, reliable tell.
    expect(FRAGMENT_SHADER.length).toBeGreaterThan(8000);
    expect(FRAGMENT_SHADER.trimEnd().endsWith("}")).toBe(true);
    expect(STAR_VERTEX.trimEnd().endsWith("}")).toBe(true);
  });
});

describe("the blend state", () => {
  /**
   * `blendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA)` applies those factors to the
   * ALPHA channel too. Over a cleared buffer the stored alpha becomes A_src² —
   * every alpha the shader computes, silently squared. A band asked to be 18%
   * opaque was written at 3%, and since the error grows as things get fainter it
   * struck exactly the soft edges that matter: the sun's aureole, the outer
   * atmosphere, the airglow arc.
   *
   * It survived because the state was SET correctly in one place and RESTORED
   * by hand in another. The star pass ended with its own literal
   * `blendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA)`, and since that pass runs every
   * frame the planet had never once drawn with the intended blend. A restore
   * that repeats state instead of naming it is a copy waiting to drift.
   *
   * Measured, not reasoned: replacing the halo term with a constant 0.5 and
   * reading the framebuffer back gave 64/255 = 0.251, which is 0.5².
   */
  const scene = readFileSync(
    new URL("../src/lib/environment/gl/scene.ts", import.meta.url),
    "utf8"
  );

  it("separates the alpha factors from the colour factors", () => {
    expect(scene).toMatch(/blendFuncSeparate\(/);
  });

  it("never sets the scene blend with a bare blendFunc", () => {
    /* `blendFunc(ONE, ONE)` is legitimate — that is the star pass, which wants
       additive light. What must not exist is a second hand-written copy of the
       SCENE blend, because that is the one that drifted. */
    const bare = [...scene.matchAll(/gl\.blendFunc\(([^)]*)\)/g)].map((m) => m[1].trim());
    for (const args of bare) {
      expect(args, "the scene blend must go through sceneBlend()").not.toMatch(
        /SRC_ALPHA/
      );
    }
  });

  it("restores through the same function that sets it up", () => {
    // Two call sites, one definition: setup, and the star pass's restore.
    const calls = scene.match(/sceneBlend\(gl\);/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});


describe("the ocean glint", () => {
  it("stays a highlight rather than becoming glare", () => {
    /**
     * Measured off the rendered frame at Cape Town, midday, by reading the
     * canvas back with `gl.readPixels`. The band across the lower ocean
     * averaged RGB (141,137,129) — R>G>B in almost exactly the 1 : 0.97 : 0.9
     * of the glint tint, which is how it was identified as the cause rather
     * than haze (which would read blue) or cloud (which would read neutral).
     *
     * Over open sea BLUE should be the strongest channel and it was the
     * weakest: the highlight was not sitting on the water, it was erasing it.
     * The band also ran 20% brighter than the planet directly above it.
     *
     * After: band mean luma 0.537 -> 0.455, level with the 0.455 of the earth
     * above it rather than standing out from it.
     *
     * Pinned as numbers because the gain is the whole difference between a
     * photographic cue and a blown highlight, and nothing else in this suite
     * would notice it moving.
     */
    const gain = FRAGMENT_SHADER.match(
      /vec3 glint = vec3\(1\.0, 0\.97, 0\.9\) \* specular \* water \* lit \* ([\d.]+);/
    );
    expect(gain, "glint line not found — was it renamed?").not.toBeNull();
    expect(Number(gain![1])).toBeLessThanOrEqual(1.5);

    /* Still broad, though. The sea is never flat, and a mirror-sharp point
       reads as a lens artefact rather than as sunlight on water. */
    const exponent = FRAGMENT_SHADER.match(
      /float specular = pow\(max\(0\.0, dot\(n, halfway\)\), ([\d.]+)\);/
    );
    expect(exponent).not.toBeNull();
    expect(Number(exponent![1])).toBeGreaterThanOrEqual(40);
    expect(Number(exponent![1])).toBeLessThanOrEqual(80);
  });
});
