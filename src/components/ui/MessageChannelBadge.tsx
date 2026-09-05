import { Mail, MessageSquare } from "lucide-react";
import type { Channel } from "@/server/repos/inbox";

/**
 * How a message arrived, on the corner of the sender's avatar.
 *
 * Deliberately NOT `ChannelBadge`, which answers a different question. That one
 * shows where a CONTACT came from — Facebook, Google Ads, a referral — a fact
 * about the person that does not change. This shows how THIS message reached
 * you, which changes with every message.
 *
 * Conflating them is what the inbox did until now: somebody who first found the
 * business through Facebook two years ago and had just sent a WhatsApp still
 * showed a Facebook badge, on the one screen whose whole question is what came
 * in and by what route. Two facts, two components, no chain of fallbacks
 * between them.
 *
 * The style table is exhaustive over `Channel`, so adding a transport without
 * deciding how it looks is a compile error rather than an envelope drawn by a
 * default branch — the same mistake this badge's predecessor made twice.
 */

const STYLE: Record<Channel, { bg: string; fg: string; label: string; Glyph: () => React.ReactNode }> = {
  email: {
    bg: "#2f6bff",
    fg: "#ffffff",
    label: "Arrived by email",
    Glyph: () => <Mail className="h-3 w-3" strokeWidth={2.5} />,
  },
  whatsapp: {
    // WhatsApp's own green. A brand people recognise faster than any label.
    bg: "#25D366",
    fg: "#0b1220",
    label: "Arrived on WhatsApp",
    Glyph: WhatsAppGlyph,
  },
  sms: {
    bg: "#8b5cf6",
    fg: "#ffffff",
    label: "Arrived by SMS",
    Glyph: () => <MessageSquare className="h-3 w-3" strokeWidth={2.5} />,
  },
};

/**
 * WhatsApp's mark, drawn rather than imported.
 *
 * Lucide has no WhatsApp glyph — its brand icons were removed — and a generic
 * speech bubble in green is not recognisable as WhatsApp, which is the entire
 * value of showing it. One path, no dependency, no network request.
 */
function WhatsAppGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-3 w-3" fill="currentColor" aria-hidden>
      <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.46 1.32 4.96L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91S17.5 2 12.04 2Zm5.8 14.16c-.24.68-1.2 1.26-1.96 1.42-.52.11-1.2.2-3.5-.75-2.94-1.22-4.83-4.2-4.98-4.4-.14-.19-1.19-1.58-1.19-3.02s.75-2.14 1.02-2.43c.27-.29.59-.36.78-.36l.56.01c.18.01.42-.7.66.5.24.58.82 2.01.89 2.16.07.14.12.31.02.5-.09.19-.14.31-.28.48l-.42.49c-.14.14-.28.29-.12.57.16.29.72 1.19 1.55 1.93 1.07.95 1.97 1.25 2.26 1.39.28.14.45.12.61-.07.17-.19.71-.83.9-1.11.19-.29.38-.24.64-.14.26.09 1.68.79 1.97.94.29.14.48.21.55.33.07.12.07.7-.17 1.38Z" />
    </svg>
  );
}

export function MessageChannelBadge({ channel }: { channel: Channel }) {
  const { bg, fg, label, Glyph } = STYLE[channel];
  return (
    <span
      /* Ringed in the panel colour so it separates from the avatar behind it.
         Its predecessor was a 14%-alpha fill on a dark panel, which read as
         "small black circles" and was reported as exactly that. */
      className="absolute -bottom-0.5 -right-0.5 grid h-[18px] w-[18px] place-items-center rounded-full ring-2 ring-[var(--panel-solid)]"
      style={{ background: bg, color: fg }}
      title={label}
      aria-label={label}
    >
      <Glyph />
    </span>
  );
}
