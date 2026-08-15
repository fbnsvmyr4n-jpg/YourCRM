"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Never changes, so React never needs to re-subscribe. */
const noop = () => () => {};

/**
 * Renders full-screen UI at `<body>` instead of where it was written.
 *
 * `position: fixed` is only relative to the viewport while no ancestor has
 * claimed to be a containing block. Several things in this app claim it:
 * `.card` sets `backdrop-filter`, and `<main>` now sets `container-type` so the
 * page grids can size themselves against their own box rather than the window.
 * Both also open a stacking context, so a `z-50` dialog written inside `<main>`
 * competes with `<main>`, not with the sidebar.
 *
 * Left in place, a "full-screen" overlay is trapped inside the content area,
 * scrolls with it, and can paint *underneath* the sidebar. Every such overlay
 * goes through here so the guarantee is structural rather than remembered.
 */
export function Overlay({ children }: { children: ReactNode }) {
  // `document` doesn't exist while this renders on the server, and the portal
  // target has to be the same node the client will hydrate against. The server
  // snapshot says "not yet"; the client snapshot says "go".
  const mounted = useSyncExternalStore(
    noop,
    () => true,
    () => false
  );

  if (!mounted) return null;
  return createPortal(children, document.body);
}
