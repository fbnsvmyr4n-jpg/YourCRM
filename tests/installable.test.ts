import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Whether YourCRM can be installed to a home screen.
 *
 * Asked directly, after a screen recording of the chat composer sliding around
 * under the keyboard: is this just Safari, and would an app not have the
 * problem? Partly — and the part that would is worth having on its own.
 *
 * Installed, iOS runs the page without the URL bar and without the toolbar
 * above the keyboard: roughly 110pt of a 700pt screen handed back, and no
 * toolbar collapsing and expanding as you scroll. That last one is the root of
 * most of the layout trouble this project has had on a phone, because a
 * viewport that changes height under you is what every one of those fixes was
 * working around.
 *
 * It is NOT a substitute for fixing the layout. The flicker that prompted the
 * question was ours — 191px of suggestions appearing and disappearing on every
 * keystroke — and it would have flickered just as badly inside an app.
 */

const manifestSource = readFileSync(
  fileURLToPath(new URL("../src/app/manifest.ts", import.meta.url)),
  "utf8"
);
/* Comments quote the code they explain — the prose above `display` contains the
   literal `display: "standalone"`, so asserting against the raw file passed
   with the manifest set to `"browser"`. Caught by mutation, for the third time
   in this project. Strip them and match the code. */
const manifest = manifestSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const layout = readFileSync(
  fileURLToPath(new URL("../src/app/layout.tsx", import.meta.url)),
  "utf8"
);

describe("the manifest", () => {
  it("declares a standalone app, not a bookmark", () => {
    /* `standalone` is the whole point: it is what drops the browser chrome. */
    expect(manifest).toMatch(/display: "standalone"/);
    expect(manifest).toMatch(/start_url: "\/"/);
    expect(manifest).toMatch(/name: "YourCRM"/);
  });

  it("paints its own ground before anything renders", () => {
    /* The app draws a dark background; without a matching launch colour there
       is a white flash on every cold start. */
    expect(manifest).toMatch(/background_color: "#0b0f18"/);
    expect(manifest).toMatch(/theme_color: "#0b0f18"/);
  });

  it("ships an icon Android can crop without shaving the mark", () => {
    /* Android masks icons to its own shape. Without a maskable copy — the same
       mark inset into the safe zone — the corners of the diamond are cut off. */
    expect(manifest).toMatch(/purpose: "maskable"/);
    expect(manifest).toMatch(/icon-maskable-512\.png/);
    expect(manifest).toMatch(/sizes: "192x192"/);
    expect(manifest).toMatch(/sizes: "512x512"/);
  });
});

describe("the iOS half of it", () => {
  it("writes the Apple capability tag by hand", () => {
    /**
     * Next's `appleWebApp.capable` emits `mobile-web-app-capable`, which is the
     * modern standard — and iOS reads `apple-mobile-web-app-capable`. Verified
     * against the rendered head: the Apple one was simply absent, so without
     * this line an older iPhone installs a bookmark that opens in Safari.
     */
    expect(layout).toMatch(/<meta name="apple-mobile-web-app-capable" content="yes" \/>/);
  });

  it("names the icon and the home-screen label", () => {
    expect(layout).toMatch(/appleWebApp: \{ capable: true, title: "YourCRM", statusBarStyle: "default" \}/);
    expect(layout).toMatch(/apple: "\/icons\/apple-touch-icon\.png"/);
  });

  it("asks the keyboard to resize rather than pan", () => {
    /**
     * The standards-based answer to the composer sliding out of view: by
     * default a browser leaves the layout viewport alone and PANS it to reveal
     * the focused field. `resizes-content` asks it to resize instead, so the
     * composer simply sits above the keyboard.
     *
     * Chrome honours it today and Safari does not, which is why the chat page
     * still carries its own handling — this costs nothing and takes effect the
     * day Safari ships it.
     */
    expect(layout).toMatch(/interactiveWidget: "resizes-content"/);
  });

  it("runs edge to edge", () => {
    /* Letterboxed inside the rounded corners is the giveaway that something is
       a web page wearing an app icon. */
    expect(layout).toMatch(/viewportFit: "cover"/);
  });
});
