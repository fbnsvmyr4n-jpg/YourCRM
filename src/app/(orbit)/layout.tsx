import type { ReactNode } from "react";
import { OrbitScene } from "@/components/login/OrbitScene";

/**
 * One sky for every page that stands under it.
 *
 * Sign-in, sign-up and password reset all shared a backdrop and each mounted
 * its own copy of it. Moving between them therefore tore the whole scene down
 * and built it again: a fresh WebGL context, textures decoded and uploaded from
 * scratch, the star catalogue re-parsed, and — for the second or two all that
 * takes — the CSS fallback on screen instead. Reported as clicking "Create an
 * account" and briefly getting the old login screen back, which is exactly what
 * it was.
 *
 * A layout is the fix rather than a workaround. React keeps a layout mounted
 * across navigation between the routes inside it, so the canvas is never
 * unmounted, the context is never lost, and the planet simply carries on
 * drawing while the form above it changes. The environment clock keeps running
 * too, so the scene does not jump back in time.
 *
 * This only works if the links between these pages are client-side. A plain
 * `<a href>` reloads the document and destroys everything a shared layout is
 * for, which is why they are all `<Link>` now.
 */
export default function OrbitLayout({ children }: { children: ReactNode }) {
  return (
    /*
       `min-h-dvh`, not `min-h-screen`.

       `100vh` on iOS is the LARGE viewport — the height the page would have if
       the browser's toolbars were hidden — so the sky was always taller than
       the screen showing it and the whole sign-in page could be dragged. The
       dynamic unit is the height actually on screen, which is what this layout
       means: one screen, filled.

       `orbit-sky` is the other half, and the half visible in the photographs:
       dragging past the end rubber-banded and exposed the flat page colour
       behind the scene — a black band above the logo and below the footer. On
       the one screen whose whole job is to look like somewhere, the illusion
       came apart the first second anybody touched it.

       The class is a hook, not a style: `overscroll-behavior` only does
       anything on the element that actually scrolls, which is the document, not
       this one. `globals.css` turns the bounce off for the document WHILE this
       layout is on screen, so every other page keeps the behaviour it has.
    */
    <main className="orbit-sky relative flex min-h-dvh w-full items-center justify-center overflow-hidden px-5 py-14">
      <OrbitScene />
      {children}
    </main>
  );
}
