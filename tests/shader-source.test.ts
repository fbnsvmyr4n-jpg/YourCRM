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

  it("gates the moon disc on it being up, not on how much light it casts", () => {
    // A thin crescent lights nothing and is plainly visible. Keying the disc to
    // `uMoonLight` would make the moon vanish for most of the month.
    expect(FRAGMENT_SHADER).toMatch(/if \(uMoonVisible > 0\.0\)/);
  });
});
