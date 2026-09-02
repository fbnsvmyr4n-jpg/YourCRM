import { CircleDashed, Globe, Mail, PhoneCall, PhoneOutgoing, Users } from "lucide-react";
import type { LeadSource } from "@/data/leads";

/**
 * Where a contact came from, shown on the corner of their avatar.
 *
 * This badge previously rendered a field called `channel`, whose type was
 * `"amber" | "green" | "blue"` — **colour names, not sources**. Two of the three
 * drew the same envelope, so five messages produced two treatments and the
 * badge reported nothing at all while looking like it reported something.
 *
 * It now shows a real value: the acquisition source when the sender is a known
 * lead, and otherwise the channel the message genuinely arrived on. Everything
 * in this inbox is email, so that fallback is a fact rather than a guess.
 *
 * Legibility was the reported symptom. The old badge was 20px with a 12px glyph
 * on a **14%-alpha** fill, which against a dark panel is very nearly the panel —
 * hence "small black circles". These are solid, larger, and ringed in the panel
 * colour so they separate from the avatar behind them.
 */

export type ContactChannel = LeadSource | "Email";

/**
 * Every channel's colour, wording AND glyph, in one exhaustive table.
 *
 * The glyph used to be picked by a chain of ternaries ending in an envelope,
 * which meant a channel nobody had thought about drew "email" — the same shape
 * of bug as the colour-named `channel` this component was built to replace, and
 * it happened again the moment three sources were added: Website, Outbound and
 * Other all resolved to a mail icon. Declared here, `Record<ContactChannel, …>`
 * makes leaving one out a compile error instead of a wrong picture.
 */
const STYLE: Record<
  ContactChannel,
  { bg: string; fg: string; label: string; edge?: string; Glyph: () => React.ReactNode }
> = {
  Facebook: { bg: "#1877F2", fg: "#ffffff", label: "Came from Facebook", Glyph: FacebookGlyph },
  // Google's badge is white, and in the light theme so is `--panel-solid` — a
  // white disc inside a white ring on a white panel is nothing at all. The
  // hairline gives it an edge in both themes.
  "Google Ads": {
    bg: "#ffffff",
    fg: "#4285F4",
    label: "Came from Google Ads",
    edge: "inset 0 0 0 1px rgba(15,23,42,0.16)",
    Glyph: GoogleGlyph,
  },
  Referral: {
    bg: "var(--purple)",
    fg: "#ffffff",
    label: "Came from a referral",
    Glyph: () => <Users className="h-2.5 w-2.5" />,
  },
  "Phone Call": {
    bg: "var(--green)",
    fg: "#ffffff",
    label: "Came from a phone call",
    Glyph: () => <PhoneCall className="h-2.5 w-2.5" />,
  },
  /* A globe rather than a cursor or a screen: this is where they came FROM,
     and the site is the only one of these that is a place. */
  Website: {
    bg: "#0EA5E9",
    fg: "#ffffff",
    label: "Came from the website",
    Glyph: () => <Globe className="h-2.5 w-2.5" />,
  },
  /* The arrow points away, which is the whole distinction from Phone Call:
     one of them rang us, we rang the other. */
  Outbound: {
    bg: "#F59E0B",
    fg: "#ffffff",
    label: "Came from outbound calling",
    Glyph: () => <PhoneOutgoing className="h-2.5 w-2.5" />,
  },
  /* Deliberately plain and deliberately grey. "Other" is the absence of an
     answer, and dressing it up as a channel is how a real one gets invented. */
  Other: {
    bg: "#64748B",
    fg: "#ffffff",
    label: "Source not recorded",
    Glyph: () => <CircleDashed className="h-2.5 w-2.5" />,
  },
  Email: {
    bg: "var(--accent)",
    fg: "#ffffff",
    label: "Arrived by email",
    Glyph: () => <Mail className="h-2.5 w-2.5" />,
  },
};

/** Google's own mark, so the one white badge is still unmistakably Google. */
function GoogleGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="10" height="10" aria-hidden>
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
      <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38Z" />
    </svg>
  );
}

function FacebookGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor" aria-hidden>
      <path d="M15.12 23.85v-8.38h2.79L18.44 12h-3.32V9.75c0-.94.46-1.87 1.95-1.87h1.51V4.93s-1.37-.24-2.68-.24c-2.74 0-4.53 1.67-4.53 4.67V12H8.33v3.47h3.04v8.38a12.06 12.06 0 0 0 3.75 0Z" />
    </svg>
  );
}

export function ChannelBadge({ channel }: { channel: ContactChannel }) {
  const s = STYLE[channel];

  return (
    <span
      title={s.label}
      aria-label={s.label}
      /*
       * Sits on the avatar's corner, not on its face.
       *
       * It sits in reserved space, so it overlaps nothing at all.
       *
       * The host gives it a 48px box holding a 38px avatar at the top-left,
       * which leaves a 10px margin down and right that belongs to the badge.
       * Pinned to that box's corner it occupies x/y 32–48: clear of the widest
       * initials ("JW", which end at x=29.4 — the ring starts at 30) and clear
       * of the row's own edges, so it can no longer land on the sender's name
       * or the preview line beneath. Earlier versions solved one of those and
       * broke the other by hanging outside the avatar into a sibling's space.
       */
      className="absolute bottom-0 right-0 grid h-4 w-4 place-items-center rounded-full"
      style={{
        background: s.bg,
        color: s.fg,
        // Ringed in the panel colour rather than bordered, so the badge reads as
        // sitting in front of the avatar instead of drawn on top of it.
        boxShadow: [
          "0 0 0 2px var(--panel-solid)",
          "0 2px 6px -1px rgba(0,0,0,0.5)",
          s.edge,
        ]
          .filter(Boolean)
          .join(", "),
      }}
    >
      <s.Glyph />
    </span>
  );
}
