import type { EnvironmentState } from "./model";

/**
 * The environment, written as CSS custom properties.
 *
 * §23 says not to drive React state at 60fps and does not say what to do
 * instead — and the obvious implementation is a `useState` inside the clock,
 * which is precisely the thing being warned against. This is the alternative:
 * the clock writes numbers onto one element, and every layer reads them in
 * plain CSS.
 *
 * **React re-renders zero times per frame.** That is not only a performance
 * property. The sign-in form sits inside this subtree, and a component that
 * never re-renders cannot remount an input, cannot drop focus, and cannot lose
 * a half-typed password when the sun crosses a phase boundary — which is §16's
 * requirement, obtained for free rather than defended against.
 *
 * Custom properties inherit, so the whole scene reads from one node and the
 * cascade does the distribution.
 */

/** Every published property, so the panel and the tests can enumerate them. */
export const ENV_PROPERTIES = [
  "daylight",
  "skyBrightness",
  "warmth",
  "haze",
  "limbIntensity",
  "limbWarmth",
  "sunIntensity",
  "moonlight",
  "reflection",
  "starVisibility",
  "cityLights",
  "glassLightness",
  "glassOpacity",
  "textScrim",
  "sunX",
  "sunY",
  "sunVisible",
  "moonX",
  "moonY",
  "moonVisible",
] as const;

export type EnvProperty = (typeof ENV_PROPERTIES)[number];

/** `skyBrightness` → `--env-sky-brightness`. */
export function propertyName(key: string): string {
  return `--env-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/**
 * Write the state onto an element.
 *
 * Values are rounded to three decimals before they are written. A custom
 * property is a string, so an unrounded 0.7071067811865476 is a fifteen-
 * character allocation and a string comparison on every frame to express a
 * difference no display can render.
 *
 * The phase goes on as a data attribute rather than a property. It is not a
 * number and nothing visual may key off it — but it is what a developer panel
 * reads, and what makes the DOM legible when something looks wrong.
 */
export function publishToElement(element: HTMLElement, state: EnvironmentState): void {
  for (const key of ENV_PROPERTIES) {
    const value = state[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    element.style.setProperty(propertyName(key), value.toFixed(3));
  }
  element.dataset.phase = state.phase;
}
