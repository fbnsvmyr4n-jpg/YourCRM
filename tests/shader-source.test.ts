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
