"use client";

import { ConstellationField } from "./ConstellationField";
import { EarthLimb } from "./EarthLimb";
import { EnvironmentProvider } from "./EnvironmentProvider";
import { EnvironmentDevTools } from "./EnvironmentDevTools";
import { HorizonGlow, SolarBodies } from "./SolarBodies";

/**
 * The shared backdrop for every signed-out screen.
 *
 * Sign-in, sign-up and password reset were each assembling their own scene, so
 * redesigning one left the others on the old look — which is exactly what
 * happened: login became the view from orbit while signup kept the mountains
 * and the purple glass card. One component, used by all three.
 */
export function OrbitScene() {
  return (
    /**
     * The environment wraps the scene HERE, not on the login page.
     *
     * The specification puts the whole feature under `app/login/`, but this
     * component is the backdrop for sign-in, sign-up AND password reset — and
     * the three have already drifted apart once, which is what the note above
     * records. Building the environment onto one page would recreate that
     * split, and this time the stragglers would also be showing the wrong time
     * of day.
     */
    <EnvironmentProvider>
      <div className="orbit-sky" aria-hidden>
        {/*
          The layer order IS the physics, so it is worth reading top to bottom.
          The sky is furthest away; the stars sit in it; the sun and moon are
          beyond the planet, so the Earth draws OVER them and genuinely occults
          a setting sun rather than dissolving it; and the horizon glow comes
          last because it is light scattering in the air in FRONT of the limb,
          which is why a sunrise seen from orbit lights the planet's edge
          instead of being hidden behind it.
        */}
        <SolarBodies />
        <ConstellationField variant="plain" />
        <EarthLimb />
        <HorizonGlow />
      </div>
      <EnvironmentDevTools />
    </EnvironmentProvider>
  );
}

/**
 * The YourCRM lockup.
 *
 * Colours are written out rather than reusing `Logo`'s `var(--bg)` for the
 * inner cut: these pages sit outside the app shell, so in the light theme that
 * variable resolves to a near-white and the centre of the diamond would render
 * pale against a black sky.
 */
export function BrandLockup() {
  return (
    <div className="flex flex-col items-center gap-3">
      <svg width="46" height="46" viewBox="0 0 100 100" fill="none" className="orbit-mark" aria-hidden>
        <defs>
          <linearGradient id="orbitMark" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#4f9dff" />
            <stop offset="1" stopColor="#2ad0e0" />
          </linearGradient>
        </defs>
        <rect x="22" y="22" width="56" height="56" rx="17" transform="rotate(45 50 50)" fill="url(#orbitMark)" />
        <rect x="39" y="39" width="22" height="22" rx="6" transform="rotate(45 50 50)" fill="#050710" />
      </svg>

      <span className="orbit-wordmark">
        Your<span className="orbit-wordmark-accent">CRM</span>
      </span>
    </div>
  );
}
