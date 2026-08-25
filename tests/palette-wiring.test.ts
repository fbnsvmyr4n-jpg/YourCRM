import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { environmentFor } from "../src/lib/environment/model";
import { moonSnapshot, solarSnapshot } from "../src/lib/solar/suncalc";
import { ENV_PROPERTIES, propertyName } from "../src/lib/environment/publish";
import { scenePalette } from "../src/lib/environment/palette";

/**
 * The half of this feature no other test could see.
 *
 * Everything else in `tests/contrast.test.ts` measures the MODEL: given a sky,
 * is the computed palette readable. All of it passed for the whole life of the
 * feature — while the form on screen was using none of it.
 *
 * `<OrbitScene />` is a SIBLING of the sign-in form, and the palette was being
 * published onto a div inside the scene. Custom properties inherit downwards
 * and the form was never downwards of it, so `var(--env-card-text)`,
 * `var(--env-scrim)` and the card's entire readability wash silently resolved
 * to their fallbacks — a fixed night palette, in broad daylight.
 *
 * There was no arithmetic mistake to find. The numbers were always right; what
 * was wrong was who could read them. These are the two checks that would have
 * said so.
 */

const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
const provider = readFileSync(
  new URL("../src/components/login/EnvironmentProvider.tsx", import.meta.url),
  "utf8"
);

/* Any state at all — the palette's KEYS do not depend on the sky, only its
   values do, and it is the key set this file is about. */
const anyState = (() => {
  const when = new Date(Date.UTC(2026, 5, 21, 12, 0));
  const where = { latitude: -33.9, longitude: 18.4, source: "default" } as const;
  return environmentFor(solarSnapshot(when, where), moonSnapshot(when, where));
})();

describe("the palette reaches what consumes it", () => {
  it("publishes onto the document root, not onto a subtree", () => {
    /**
     * The specific fix, pinned — because the tempting change is to publish onto
     * the scene's own wrapper, which is where this started and where it reads
     * most naturally. Only the root is an ancestor of BOTH the scene and the
     * form.
     */
    expect(provider).toMatch(/publishToElement\(\s*document\.documentElement/);
    expect(provider, "a subtree cannot serve a sibling").not.toMatch(
      /publishToElement\(\s*host\b/
    );
  });

  it("takes the palette back off the root when the page goes away", () => {
    // On `<html>` these outlive the login page. A sunset left behind would
    // tint the CRM after sign-in, with nothing running to correct it.
    expect(provider).toMatch(/clearFromElement\(\s*document\.documentElement/);
  });

  it("has a publisher for every --env- property the stylesheet reads", () => {
    const published = new Set([
      ...ENV_PROPERTIES.map(propertyName),
      ...Object.keys(scenePalette(anyState)).map(propertyName),
      "--env-scrim",
      "--env-footer-scrim",
    ]);

    const consumed = new Set(
      [...css.matchAll(/var\(\s*(--env-[a-z0-9-]+)/g)].map((m) => m[1])
    );

    /**
     * A `var()` with a fallback never errors — it silently paints the fallback,
     * which is exactly how the original failure stayed invisible. So a name the
     * stylesheet reads and nothing writes is not a typo to be found later; it
     * is a value that will look plausible and be wrong forever.
     */
    const orphans = [...consumed].filter((name) => !published.has(name));
    expect(orphans, "read by the stylesheet, written by nobody").toEqual([]);
  });
});
