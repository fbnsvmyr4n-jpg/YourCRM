"use client";

import dynamic from "next/dynamic";

/**
 * The simulator, wired in so that production never sees it.
 *
 * §19 says the panel should be "development-only or protected behind an
 * environment flag". A flag is not protection — it is a variable somebody can
 * set, and this panel can override a user's location and the current time. So
 * the exclusion happens in the bundler instead.
 *
 * `process.env.NODE_ENV` is replaced with a literal at build time, which makes
 * this ternary a constant expression: in a production build the branch folds to
 * `null` and the dynamic import is eliminated with it, so no chunk containing
 * the panel is ever emitted. In development the import is lazy and client-only.
 *
 * `tests/dev-panel-excluded.test.ts` builds the app and searches the output for
 * strings that only exist in the panel. That is the part that matters: this
 * comment is a claim, and the test is the evidence. The same defect class has
 * already cost this project once, when a server/client boundary error passed
 * both `tsc` and `next build`.
 */
const Panel =
  process.env.NODE_ENV === "production"
    ? null
    : dynamic(() => import("./DevEnvironmentPanel").then((m) => m.DevEnvironmentPanel), {
        ssr: false,
      });

export function EnvironmentDevTools() {
  if (!Panel) return null;
  return <Panel />;
}
