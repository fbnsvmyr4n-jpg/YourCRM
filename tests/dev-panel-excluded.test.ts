import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The developer simulator must never reach a customer.
 *
 * It can override the current time and the user's location. §19 offers
 * "development-only **or** protected behind an environment flag"; a flag is not
 * protection, because a flag is a variable somebody can set on the wrong
 * deployment. So the exclusion is the bundler's job, and this is the evidence
 * that it worked.
 *
 * Two checks, and they fail in different ways on purpose:
 *
 *  - The **structural** one always runs. It is the durable guard, because the
 *    way this breaks in future is somebody adding an ordinary import of the
 *    panel somewhere else, which no amount of build configuration will save.
 *  - The **build output** one runs when a production build is present. It is
 *    the only check that proves the claim rather than restating it — this
 *    project has already shipped a defect that both `tsc` and `next build`
 *    reported as clean, so "the config looks right" is not evidence.
 */

const PANEL = "src/components/login/DevEnvironmentPanel.tsx";
const WRAPPER = "src/components/login/EnvironmentDevTools.tsx";

/** Strings that exist only in the panel, so finding one means it shipped. */
const FINGERPRINTS = ["Tromsø (Arctic)", "Open the environment simulator", "Simulated time"];

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, found);
    else if (/\.tsx?$/.test(entry)) found.push(path);
  }
  return found;
}

describe("the simulator is excluded by construction", () => {
  it("is imported from exactly one place", () => {
    // Every extra import is another door. One entry point is what makes the
    // guard below sufficient rather than merely suggestive.
    const importers = sourceFiles("src").filter(
      (file) => file !== PANEL && read(file).includes("DevEnvironmentPanel")
    );
    expect(importers).toEqual([WRAPPER]);
  });

  it("is reached only through a build-time constant", () => {
    /**
     * `process.env.NODE_ENV` is replaced with a literal during the build, which
     * makes the ternary a constant expression — so in production the branch
     * folds to `null` and the dynamic import is eliminated along with it.
     *
     * A plain `import` statement would defeat this entirely: the module would be
     * pulled into the graph whether or not the component ever rendered.
     */
    const wrapper = read(WRAPPER);
    expect(wrapper).toMatch(/process\.env\.NODE_ENV === "production"\s*\?\s*null/);
    expect(wrapper).toMatch(/import\(["']\.\/DevEnvironmentPanel["']\)/);

    const staticImport = /^\s*import\s[^\n]*DevEnvironmentPanel/m.test(wrapper);
    expect(staticImport, "a static import would pull the panel into every build").toBe(false);
  });

  it("has fingerprints worth searching for", () => {
    // The build check below is only as good as these strings. If the panel is
    // reworded and they vanish from it, that check silently starts passing for
    // the wrong reason.
    const panel = read(PANEL);
    for (const fingerprint of FINGERPRINTS) {
      expect(panel, `"${fingerprint}" is no longer in the panel`).toContain(fingerprint);
    }
  });
});

describe("the simulator is absent from a production build", () => {
  const buildDir = ".next";
  const built = existsSync(buildDir) && existsSync(join(buildDir, "static"));

  it.skipIf(!built)("ships no chunk containing the panel", () => {
    /**
     * The check that is actually evidence. Runs after `npm run build`; skipped
     * otherwise rather than quietly passing, because a check that reports green
     * when it did not run is worse than no check at all.
     */
    const chunks = [
      ...allFiles(join(buildDir, "static")),
      ...(existsSync(join(buildDir, "server")) ? allFiles(join(buildDir, "server")) : []),
    ].filter((f) => /\.(js|mjs|cjs)$/.test(f));

    expect(chunks.length, "no build output to search").toBeGreaterThan(0);

    const leaked: string[] = [];
    for (const chunk of chunks) {
      const contents = readFileSync(chunk, "utf8");
      for (const fingerprint of FINGERPRINTS) {
        if (contents.includes(fingerprint)) leaked.push(`${fingerprint} → ${chunk}`);
      }
    }

    expect(leaked, "the developer simulator was shipped to production").toEqual([]);
  });

  it.skipIf(!built)("still ships the environment itself", () => {
    /**
     * The other half of the claim, and it has already paid for itself. A build
     * that excluded the panel by excluding the whole feature would pass the test
     * above for the worst possible reason.
     *
     * The fingerprint is `--env-` and a property key, not the finished
     * `--env-sky-brightness`: the names are ASSEMBLED at runtime from a kebab
     * conversion, so the whole string exists in no source file and in no bundle.
     * Searching for it found nothing and this test went red — correctly, and for
     * a reason worth keeping in mind whenever a build is searched for evidence.
     */
    const chunks = allFiles(join(buildDir, "static")).filter((f) => f.endsWith(".js"));
    const shipped = chunks.some((f) => {
      const contents = readFileSync(f, "utf8");
      return contents.includes("--env-") && contents.includes("skyBrightness");
    });
    expect(shipped, "the environment did not ship either").toBe(true);
  });
});

function read(file: string): string {
  return readFileSync(file, "utf8");
}

function allFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) allFiles(path, found);
    else found.push(path);
  }
  return found;
}
