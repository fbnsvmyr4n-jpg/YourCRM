import { clamp01 } from "./curves";
import type { EnvironmentState } from "./model";

/**
 * The scene's colours, decided here rather than in the stylesheet.
 *
 * This exists so that "the text stays readable" can be a measurement instead of
 * an opinion. §24 asks for contrast to be maintained across the whole cycle,
 * which is a claim nobody can check by looking — the risk is concentrated in
 * the few minutes around sunrise when the sky behind a card designed for night
 * is at its brightest.
 *
 * Computing the colours in TypeScript and handing them to CSS as custom
 * properties means the test measures **exactly what the browser paints**. The
 * alternative — mixing colours in the stylesheet and mirroring the arithmetic in
 * a test — is two copies of the same decision, and the copy that drifts is
 * always the one nobody is looking at.
 *
 * It also removes a whole class of mistake. The `color-mix()` percentages in the
 * first version of the scene were written backwards and put a 45% orange wash
 * over a midday sky; here the same error would be a number in a unit test.
 */

export type Rgb = { r: number; g: number; b: number };

const rgb = (r: number, g: number, b: number): Rgb => ({ r, g, b });

/**
 * Mix two colours in **linear light**, not in sRGB.
 *
 * sRGB values are perceptually encoded, so averaging them is averaging the
 * encoding rather than the light. Blending a night sky toward a day sky in sRGB
 * passes through a desaturated grey that exists nowhere in the real transition;
 * doing it in linear light passes through the blues you actually see. It is the
 * same reason the stylesheet's own gradients interpolate in oklab.
 */
export function mix(from: Rgb, to: Rgb, t: number): Rgb {
  const k = clamp01(t);
  const blend = (a: number, b: number) => {
    const linear = toLinear(a) + (toLinear(b) - toLinear(a)) * k;
    return toSrgb(linear);
  };
  return rgb(blend(from.r, to.r), blend(from.g, to.g), blend(from.b, to.b));
}

function toLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function toSrgb(linear: number): number {
  const c = linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
  return Math.round(clamp01(c) * 255);
}

/** Composite a translucent colour over an opaque one. */
export function over(foreground: Rgb, alpha: number, background: Rgb): Rgb {
  const a = clamp01(alpha);
  return rgb(
    Math.round(foreground.r * a + background.r * (1 - a)),
    Math.round(foreground.g * a + background.g * (1 - a)),
    Math.round(foreground.b * a + background.b * (1 - a))
  );
}

/** Relative luminance, per WCAG. */
export function luminance(colour: Rgb): number {
  return (
    0.2126 * toLinear(colour.r) + 0.7152 * toLinear(colour.g) + 0.0722 * toLinear(colour.b)
  );
}

/** The WCAG contrast ratio between two opaque colours, 1…21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

export function toCss(colour: Rgb): string {
  return `rgb(${colour.r} ${colour.g} ${colour.b})`;
}

/**
 * The sky's colour stops, from night to full day.
 *
 * Three, because the gradient needs a top, a middle and a horizon — the sky
 * from orbit is not one flat colour, and the band just above the limb is
 * always the brightest part of it.
 */
const SKY_NIGHT = { top: rgb(1, 3, 10), mid: rgb(2, 4, 12), horizon: rgb(3, 6, 16) };
const SKY_DAY = { top: rgb(10, 44, 86), mid: rgb(31, 111, 174), horizon: rgb(63, 155, 214) };

/** The warm cast a low sun throws across everything. */
const WARM = rgb(255, 150, 82);

/**
 * The colour the readability wash is made of.
 *
 * A deep blue-black rather than neutral grey: it belongs to the same sky it is
 * sitting on, so at night it disappears entirely instead of leaving a visible
 * grey cloud over the stars.
 */
const SCRIM = rgb(4, 8, 18);

export type ScenePalette = {
  skyTop: Rgb;
  skyMid: Rgb;
  skyHorizon: Rgb;
  /** What sits behind the sign-in card, which is what its text competes with. */
  behindCard: Rgb;
  cardSurface: Rgb;
  /**
   * What sits behind the footer lines, which is NOT the sky.
   *
   * The form's last two rows — "New to YourCRM?" and "Secure. Private.
   * Always." — hang below the readability wash and over the PLANET, which in
   * daylight is the brightest thing in the frame by a wide margin. The contrast
   * work measured text against the sky and passed, while those two lines sat
   * over sunlit cloud and were barely readable.
   *
   * Modelled as the worst case rather than the average: lit cloud, which is
   * near-white. Land and ocean are darker, so anything legible over cloud is
   * legible over all of it.
   */
  behindFooter: Rgb;
  footerSurface: Rgb;
  cardText: Rgb;
  cardMuted: Rgb;
  cardBorder: Rgb;
};

/**
 * The scrim as CSS paints it: a colour with an alpha, not a pre-composited one.
 *
 * The stylesheet has to lay this OVER the real sky — the gradient behind the
 * form is not a flat colour, and pre-compositing would paint a solid patch that
 * ignores the sun's glow passing behind the text. Handing CSS the same colour
 * and the same alpha the model composited with means the browser arrives at the
 * measured surface by doing the arithmetic itself.
 */
export function scrimCss(state: EnvironmentState): string {
  return `rgb(${SCRIM.r} ${SCRIM.g} ${SCRIM.b} / ${scrimAlpha(state).toFixed(3)})`;
}

export function footerScrimCss(state: EnvironmentState): string {
  return `rgb(${SCRIM.r} ${SCRIM.g} ${SCRIM.b} / ${footerScrimAlpha(state).toFixed(3)})`;
}

/**
 * How opaque the readability wash is.
 *
 * Exported so a test can assert it directly. Inferring it from the composited
 * luminance does not work: that difference is dominated by how bright the sky
 * is, not by how strong the wash is — a sweep written that way passed happily
 * with the whole relationship inverted, because near-black minus near-black is
 * near zero whatever the alpha.
 */
export function scrimAlpha(state: EnvironmentState): number {
  return clamp01(0.1 + state.textScrim * 0.82);
}

/**
 * How opaque the wash behind the footer lines is.
 *
 * Heavier than the card's, and driven by DAYLIGHT rather than by sky
 * brightness, because what it has to overcome is the lit planet rather than
 * the sky. At night it all but disappears, exactly like the other one — over a
 * dark planet there is nothing to defend against.
 *
 * Square-rooted, and that is the part that was wrong on the first attempt.
 * A linear ramp left a twenty-minute hole either side of sunrise and sunset
 * where the text sat at 4.2:1 — because a planet does not brighten in step
 * with `daylight`. The sun clears the horizon and the limb is *already* fully
 * lit; what the next hour changes is how much of the disc is lit, not how
 * bright the lit part is. The wash has to reach nearly full strength as soon
 * as there is any sun at all, and the sweep below is what says whether it does.
 */
export function footerScrimAlpha(state: EnvironmentState): number {
  return clamp01(0.12 + Math.sqrt(clamp01(state.daylight)) * 0.74);
}

/**
 * Text stays near-white throughout, and the card moves instead.
 *
 * Flipping to dark text on a bright sky would be the obvious way to hold
 * contrast, and it is the wrong one: the card would stop being the same object
 * under changing light and start being two different designs that swap over.
 * §16 is explicit that the material may react while the design does not.
 *
 * So readability is bought by darkening and thickening the glass as the sky
 * brightens, which is what a real smoked panel does.
 */
const TEXT = rgb(244, 248, 255);
const MUTED = rgb(196, 209, 226);

export function scenePalette(state: EnvironmentState): ScenePalette {
  const brightness = clamp01(state.skyBrightness);
  const warmth = clamp01(state.warmth);

  /**
   * Warmth belongs near the horizon, not across the whole sky.
   *
   * Applying it evenly — which the first version did — turns a sunrise into a
   * uniform mauve wash, and washes out the one thing that makes the phase
   * recognisable. The colour of a low sun is made by light travelling through a
   * great deal of atmosphere, and there is only a great deal of atmosphere
   * along the horizon; look up and the sky is still deep blue. Weighting the
   * tint by height is what gives dawn its band instead of its haze.
   */
  const blend = (night: Rgb, day: Rgb, warmShare: number, lit = brightness) => {
    const base = mix(night, day, lit);
    return mix(base, WARM, warmth * warmShare);
  };

  /**
   * The top of the frame darkens faster than the horizon does.
   *
   * Seen from orbit the upper frame is looking OUT, at space; the blue there is
   * atmosphere seen edge-on, and it thins with altitude. So as the terminator
   * passes, the top goes dark well before the limb does — which is exactly what
   * the reference frames show: near-black above, an intense band below.
   *
   * Applied evenly, twilight came out a uniform mauve across the whole frame.
   * Squaring the brightness for the top stop leaves full daylight untouched
   * (1² = 1) and pulls everything below it down hard, which is the shape this
   * needs: bright days stay bright, dusk falls off a cliff.
   *
   * The warm shares had to come down with it, and the tests are what said so.
   * A darker base makes the same fraction of orange count for far more: the
   * top went from a red-minus-blue bias of 2 to 21 without its share changing
   * at all, because the blue it was competing with had gone. Warmth is a
   * RATIO against what is already there, not an amount.
   */
  const skyTop = blend(SKY_NIGHT.top, SKY_DAY.top, 0.02, brightness * brightness);
  const skyMid = blend(SKY_NIGHT.mid, SKY_DAY.mid, 0.18, Math.pow(brightness, 1.4));
  const skyHorizon = blend(SKY_NIGHT.horizon, SKY_DAY.horizon, 0.62);

  /**
   * The card sits across the upper middle of the frame, so what is behind it is
   * between the top and mid stops. Taken as the BRIGHTER of the two rather than
   * an average: the contrast requirement is about the worst case, and averaging
   * would quietly excuse the part of the card sitting over the brighter half.
   */
  const behindCard = luminance(skyMid) > luminance(skyTop) ? skyMid : skyTop;

  /**
   * The scrim, and why it is a wash rather than a panel.
   *
   * This design has no card box — the fields sit directly on the sky, which is
   * most of why it looks like a window rather than a form. So the readability
   * treatment §24 asks for cannot be "put the text on a surface"; it has to be
   * a soft darkening of the sky exactly where the text is, wide and edgeless
   * enough to read as atmosphere instead of a rectangle.
   *
   * It deepens as the sky brightens, which is the opposite of what a naive
   * implementation does. The instinct is to lighten the treatment in daylight
   * to match the mood; that is precisely when white text is in trouble.
   */
  const cardSurface = over(SCRIM, scrimAlpha(state), behindCard);

  /*
     The footer's own backdrop and its own, heavier, wash.

     Sunlit cloud is near-white and the text over it is near-white, so no amount
     of tinting saves this — the only thing that works is putting something
     genuinely dark in between. That is why the footer wash is substantially
     stronger than the card's, and why it tracks DAYLIGHT rather than sky
     brightness: what it has to overcome is the planet, lit by the sun directly,
     not the sky behind it.

     Modelled as the worst case rather than the average — lit cloud, near-white.
     Land and ocean are darker, so anything legible over cloud is legible over
     all of it.
  */
  const behindFooter = mix(rgb(6, 10, 20), rgb(228, 232, 238), clamp01(state.daylight));
  const footerSurface = over(SCRIM, footerScrimAlpha(state), behindFooter);

  return {
    skyTop,
    skyMid,
    skyHorizon,
    behindCard,
    cardSurface,
    behindFooter,
    footerSurface,
    cardText: TEXT,
    cardMuted: MUTED,
    /**
     * Field edges brighten with the day so the pills stay findable against a
     * light sky — the one place `glassLightness` is used, because it describes
     * the material rather than the readability of what sits on it.
     */
    cardBorder: over(rgb(255, 255, 255), 0.12 + clamp01(state.glassLightness) * 0.22, cardSurface),
  };
}
