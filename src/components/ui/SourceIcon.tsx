import { CircleDashed, Globe, PhoneCall, PhoneOutgoing, Users } from "lucide-react";
import type { LeadSource } from "@/data/leads";

/**
 * A tinted disc for the sources that do not have a brand mark of their own.
 *
 * Google and Facebook keep their real logos below; everything else gets one of
 * these. Written as a table rather than the trailing `return` this used to end
 * with: that fell through to the referral icon, so once Website, Outbound and
 * Other existed, a lead captured from the website wore a "referral" badge on
 * its card — the same lie the source panel was telling in numbers.
 */
const DISC: Record<
  Exclude<LeadSource, "Google Ads" | "Facebook">,
  { tint: string; color: string; Glyph: () => React.ReactNode }
> = {
  "Phone Call": {
    tint: "var(--green-soft)",
    color: "var(--green)",
    Glyph: () => <PhoneCall className="h-2.5 w-2.5" style={{ color: "var(--green)" }} />,
  },
  Referral: {
    tint: "var(--accent-soft)",
    color: "var(--accent)",
    Glyph: () => <Users className="h-2.5 w-2.5 text-accent" />,
  },
  Website: {
    tint: "rgba(14,165,233,0.16)",
    color: "#0EA5E9",
    Glyph: () => <Globe className="h-2.5 w-2.5" style={{ color: "#0EA5E9" }} />,
  },
  /* The arrow points away — the one thing that separates this from Phone Call
     is who rang whom. */
  Outbound: {
    tint: "rgba(245,158,11,0.16)",
    color: "#F59E0B",
    Glyph: () => <PhoneOutgoing className="h-2.5 w-2.5" style={{ color: "#F59E0B" }} />,
  },
  /* Grey and dashed on purpose. "Other" is a missing answer, and giving it a
     confident colour is how a source nobody recorded starts looking like one
     somebody did. */
  Other: {
    tint: "rgba(100,116,139,0.18)",
    color: "#64748B",
    Glyph: () => <CircleDashed className="h-2.5 w-2.5" style={{ color: "#64748B" }} />,
  },
};

export function SourceIcon({ source }: { source: LeadSource }) {
  if (source === "Google Ads") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z" />
        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
        <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z" />
        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38Z" />
      </svg>
    );
  }
  if (source === "Facebook") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
        <path
          fill="#1877F2"
          d="M24 12a12 12 0 1 0-13.88 11.85v-8.38H7.08V12h3.04V9.36c0-3 1.79-4.67 4.53-4.67 1.31 0 2.68.24 2.68.24v2.95h-1.51c-1.49 0-1.95.93-1.95 1.87V12h3.32l-.53 3.47h-2.79v8.38A12 12 0 0 0 24 12Z"
        />
      </svg>
    );
  }
  /* After the two brand marks, so what is left is exactly the set `DISC`
     covers and TypeScript can check it. The old tail rendered the referral disc
     for anything that reached it, which is how a website lead came to wear a
     referral badge. */
  const disc = DISC[source];

  return (
    <span
      className="grid h-4 w-4 place-items-center rounded-full"
      style={{ background: disc.tint }}
    >
      <disc.Glyph />
    </span>
  );
}
