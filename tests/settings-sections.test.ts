import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SECTION_IDS, sectionFromParam } from "../src/app/(app)/settings/sections";
import { ROLES } from "../src/server/tenant";

/**
 * Settings is six areas shown one at a time, and two lookup tables decide what
 * each one is called and what each role is described as.
 *
 * A missing key in either is silent: `META[id]` is `undefined`, the heading
 * renders as nothing, and the page still loads. That is exactly the kind of gap
 * that survives a manual pass — you check the tab you are working on.
 *
 * The tables live in a `"use client"` module, so they are read as source rather
 * than imported. That is weaker than an import and worth saying: it proves a key
 * is written, not that it holds anything sensible. The first assertion below
 * guards the guard — if the file is renamed or restructured the test fails
 * loudly instead of matching nothing.
 */

const ROOT = join(__dirname, "..", "src", "app", "(app)", "settings");
const nav = readFileSync(join(ROOT, "SettingsNav.tsx"), "utf8");
const team = readFileSync(join(ROOT, "TeamCard.tsx"), "utf8");

/** The body of `const NAME: ... = { ... };`, so a key elsewhere in the file does not count. */
function tableOf(src: string, name: string): string {
  const start = src.indexOf(`const ${name}`);
  expect(start, `${name} was not found — this test is matching nothing`).toBeGreaterThan(-1);
  const open = src.indexOf("{", start);
  const end = src.indexOf("\n};", open);
  expect(end, `${name} does not close as expected`).toBeGreaterThan(open);
  return src.slice(open, end);
}

describe("which area to open", () => {
  it("opens the area the URL names", () => {
    for (const id of SECTION_IDS) {
      expect(sectionFromParam(id)).toBe(id);
    }
  });

  it("falls back to Account rather than rendering nothing", () => {
    // Every one of these arrives from a hand-edited address bar sooner or later.
    for (const bad of [undefined, "", "billing2", "../deals", "ACCOUNT", "team "]) {
      expect(sectionFromParam(bad), `"${bad}" was accepted`).toBe("account");
    }
  });

  it("offers the areas in a deliberate order, account first", () => {
    // The rail and the chips both render this array as given, so the order is
    // the design rather than an accident of object iteration.
    expect(SECTION_IDS[0]).toBe("account");
    expect(new Set(SECTION_IDS).size).toBe(SECTION_IDS.length);
  });
});

describe("every area is described", () => {
  it("has a label and a blurb in the nav's table", () => {
    const meta = tableOf(nav, "META");
    for (const id of SECTION_IDS) {
      expect(meta, `no META entry for "${id}" — its heading would render empty`).toContain(
        `${id}: {`
      );
    }
  });
});

describe("every role is described", () => {
  it("has a colour", () => {
    const tone = tableOf(team, "ROLE_TONE");
    for (const role of ROLES) {
      expect(tone, `no ROLE_TONE entry for "${role}"`).toContain(`${role}: {`);
    }
  });

  it("has a plain-English explanation of what it may do", () => {
    // Shown beside each radio when inviting somebody. A missing one means
    // choosing a role with nothing said about what it grants.
    const blurb = tableOf(team, "ROLE_BLURB");
    for (const role of ROLES) {
      expect(blurb, `no ROLE_BLURB entry for "${role}"`).toContain(`${role}: "`);
    }
  });
});
