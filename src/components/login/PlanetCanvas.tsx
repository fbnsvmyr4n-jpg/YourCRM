"use client";

import { useEffect, useRef, useState } from "react";
import { useEnvironmentClock } from "./EnvironmentProvider";
import { PlanetScene } from "@/lib/environment/gl/scene";
import { facingBearing } from "@/lib/environment/projection";

/**
 * The real planet, when the device can draw one.
 *
 * A WebGL surface sitting between the star field and the sign-in card. It
 * renders NASA's own imagery of the Earth, lit from the true solar direction,
 * with the atmosphere's blue and the sunset's orange computed by integrating
 * Rayleigh and Mie scattering rather than painted as gradients.
 *
 * ## It is an enhancement, and behaves like one
 *
 * The CSS scene underneath is a complete picture, not a placeholder. This
 * canvas fades in over it only once WebGL2 has initialised and all three
 * textures have decoded. No WebGL, no textures, offline, a lost context, or a
 * device that cannot keep up — any of those and what remains is the scene that
 * was already on screen. Nothing here is awaited by anything on the sign-in
 * path, and the form is interactive throughout.
 *
 * ## It does not own a clock
 *
 * `render` is called from the environment clock's publish, so the planet, the
 * sky and the card always describe the same instant — §11's one-clock rule. It
 * also means the scene keeps drawing in a throttled tab, where a private
 * animation loop would simply stop.
 */
export function PlanetCanvas() {
  const clock = useEnvironmentClock();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !clock) return;

    const scene = PlanetScene.create(canvas);
    if (!scene) return; // No WebGL2. The CSS scene stands, silently.

    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    let motionCleanup: (() => void) | null = null;

    /**
     * A lost context is not an error to report; it is a laptop that slept, or a
     * driver that reset. Stop drawing and fall back — the CSS scene is still
     * behind us, so this reads as the planet quietly going away rather than as
     * anything breaking.
     */
    const onLost = (event: Event) => {
      event.preventDefault();
      setLive(false);
      // Hand the sky back to CSS, or a lost context leaves a black frame.
      delete document.documentElement.dataset.planet;
      unsubscribe?.();
    };
    canvas.addEventListener("webglcontextlost", onLost);

    // Stars are their own request and their own failure. A sky without them is
    // worse; a scene that waited for them and lost would be nothing at all.
    void scene.loadStars();

    scene.loadTextures().then((loaded) => {
      if (cancelled || !loaded) return;

      scene.setQuality(clock.isLowPower() ? "low" : "full");

      /* The clock already subscribes to the media query and is the single
         source of truth for this; asking it each frame is cheaper than a second
         listener that could disagree with the first. */
      const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
      scene.setReducedMotion(motion.matches);
      const onMotion = (e: MediaQueryListEvent) => scene.setReducedMotion(e.matches);
      motion.addEventListener("change", onMotion);
      motionCleanup = () => motion.removeEventListener("change", onMotion);

      const draw = () => {
        if (cancelled) return;
        scene.render(
          clock.read(),
          clock.solar(),
          clock.moon(),
          clock.where(),
          // The same camera bearing the CSS projection uses, so the two agree
          // about which way we are facing while they are cross-fading.
          facingBearing(clock.solar())
        );
      };

      /*
         Twenty frames a second, not sixty.
         
         The planet needs redrawing continuously now that weather moves across
         it — but this shader marches the atmosphere sixteen times per pixel,
         each of those sampling the light path six more, over two million
         pixels. Running it at sixty on a page somebody looks at for twenty
         seconds is a real cost in battery for no visible gain: the clouds take
         twenty minutes to cross the planet, so fifty milliseconds between
         frames is far finer than the motion being shown.
         
         `onPublish` stays subscribed as well, so a scrub or a snap redraws at
         once instead of waiting out the interval.
      */
      const MIN_FRAME_MS = 50;
      let lastDraw = 0;
      const drawThrottled = () => {
        const now = performance.now();
        if (now - lastDraw < MIN_FRAME_MS) return;
        lastDraw = now;
        draw();
      };

      const stopTicks = clock.onTick(drawThrottled);
      const stopPublish = clock.onPublish(() => {
        lastDraw = performance.now();
        draw();
      });
      unsubscribe = () => {
        stopTicks();
        stopPublish();
      };
      // A sharper surface arriving later must be drawn immediately rather than
      // waiting for the next tick — on a still scene the next tick may be a
      // while, and on a hidden tab it may never come.
      scene.onUpgrade = draw;
      draw(); // Once immediately: the first frame must not wait for a tick.
      setLive(true);
      /**
       * Tell the document the planet is drawing.
       *
       * The CSS scene and the shader are two different models of the same sky —
       * the shader says space above the atmosphere is black, the CSS says the
       * sky is blue everywhere — and composited together they produced a dark
       * ring around the limb where the two disagreed. Only one can be right at
       * a time, and once the shader is live it is the one computing the answer.
       *
       * On the root rather than a class here, because `.sky-wash` is an EARLIER
       * sibling and CSS can only select forwards.
       */
      document.documentElement.dataset.planet = "live";
    });

    return () => {
      cancelled = true;
      canvas.removeEventListener("webglcontextlost", onLost);
      delete document.documentElement.dataset.planet;
      motionCleanup?.();
      unsubscribe?.();
      scene.dispose();
    };
  }, [clock]);

  return (
    <canvas
      ref={canvasRef}
      className="planet-canvas"
      data-live={live ? "true" : "false"}
      aria-hidden
    />
  );
}
