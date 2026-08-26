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
    <main className="relative flex min-h-screen w-full items-center justify-center overflow-hidden px-5 py-14">
      <OrbitScene />
      {children}
    </main>
  );
}
