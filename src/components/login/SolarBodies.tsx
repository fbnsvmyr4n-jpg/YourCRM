/**
 * The sun and the moon, and the light they throw.
 *
 * Every element here is positioned and lit entirely by the `--env-*` custom
 * properties the clock publishes. There is no JavaScript in this file at all —
 * no state, no effect, no per-frame work — which is the point of §23's rule
 * about not driving React at 60fps. The whole scene animates in the compositor
 * from numbers written onto one ancestor.
 *
 * Order is load-bearing. The bodies are rendered BEFORE the Earth, so the
 * planet draws over them and genuinely occults a setting sun rather than the
 * sun fading out in front of the thing that should be hiding it. That is what
 * §29 means by sunset reading as descent instead of a dissolve — the geometry
 * does the work, and the disc's own ramp only softens the last half-degree.
 */
export function SolarBodies() {
  return (
    <>
      {/*
        The sky itself: one wash whose colour and brightness come from the
        model. Night is never pure black — there is always airglow, and every
        reference frame shows it.
      */}
      <div className="sky-wash" aria-hidden />

      {/*
        The sun's glow in the atmosphere, which is far larger than the sun and
        is most of what actually lights the frame. Separate from the disc so it
        can outlive it: the glow is still there minutes after the body has gone
        behind the planet, which is the whole character of a sunset.
      */}
      <div className="sun-glow" aria-hidden />

      {/* The moon's, much smaller and cooler, and gated on it being lit. */}
      <div className="moon-glow" aria-hidden />

      {/* The bodies themselves. */}
      <div className="sun-body" aria-hidden>
        <div className="sun-rays" />
        <div className="sun-disc" />
      </div>

      <div className="moon-body" aria-hidden>
        <div className="moon-disc" />
      </div>
    </>
  );
}

/**
 * The warm band along the horizon where the sun sits behind the atmosphere.
 *
 * Rendered after the Earth rather than before it, because this is light
 * scattering in the air *in front of* the limb — the reason a sunrise seen
 * from orbit lights the planet's edge rather than being hidden by it. It
 * tracks the sun horizontally, so the bright part of the rim moves along the
 * curve as the day does, which is the single most characteristic thing in the
 * reference set.
 */
export function HorizonGlow() {
  return <div className="horizon-glow" aria-hidden />;
}
