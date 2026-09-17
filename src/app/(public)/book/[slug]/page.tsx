import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { withPublicLookup, withTenant } from "@/server/tenant";
import { resolveSlug } from "@/server/repos/booking-links";
import { getSettings } from "@/server/repos/settings";
import { availabilityFor } from "@/server/booking/availability";
import { BookingView } from "./BookingView";

/**
 * A booking page on the public internet.
 *
 * No session, and none expected. The route sits outside the `(app)` group, so
 * the sign-in redirect in that layout never runs here — which is the point, and
 * why nothing on this page may read anything the slug did not entitle it to.
 *
 * Rendered per request. Availability is a statement about right now, and a
 * cached page would keep offering a slot somebody took ten minutes ago.
 */
export const dynamic = "force-dynamic";

/* Somebody's diary is not something to hand to a search engine. A link shared
   with a client is fine; the same page appearing in results is not. */
export const metadata: Metadata = {
  title: "Book a time",
  robots: { index: false, follow: false },
};

export default async function BookingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const link = await withPublicLookup("slug", slug, (sys) => resolveSlug(sys, slug));
  /* Unpublished and nonexistent are the same answer from outside. A different
     response for "exists but off" would let anybody map which businesses use
     the product. */
  if (!link) notFound();

  const ctx = {
    agencyId: link.agencyId,
    subAccountId: link.subAccountId,
    userId: link.ownerUserId,
    role: "owner" as const,
  };

  const { availability, timeZone } = await withTenant(ctx, async (q) => ({
    timeZone: (await getSettings(q)).timeZone,
    availability: await availabilityFor(q, {
      days: link.daysAhead,
      slotMinutes: link.slotMinutes,
      minNoticeMinutes: link.noticeMinutes,
    }),
  }));

  return (
    <BookingView
      slug={link.slug}
      workspaceName={link.workspaceName}
      title={link.title}
      kind={link.kind}
      slotMinutes={link.slotMinutes}
      timeZone={timeZone}
      /* Only instants cross to the browser. The reason a page is unavailable is
         reduced to whether it is, so nothing about the workspace's setup is
         described to a stranger. */
      days={availability.ok ? availability.days : []}
      taking={availability.ok}
    />
  );
}
