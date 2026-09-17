import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { withPublicLookup } from "@/server/tenant";
import { resolveSlug } from "@/server/repos/booking-links";
import { EnquiryView } from "./EnquiryView";

/**
 * An enquiry form on the public internet.
 *
 * No session, and none expected — the route sits outside the `(app)` group, so
 * the sign-in redirect never runs here. It may also be shown inside a frame on
 * the business's own website, so it carries no navigation of its own and asks
 * for nothing beyond what an enquiry needs.
 *
 * It reads exactly one thing: whether this link is published for enquiries,
 * and the workspace's name to address the message to.
 */
export const dynamic = "force-dynamic";

/* A form that creates leads in somebody's CRM is not something to hand to a
   search engine. The link shared, or the frame embedded, is fine. */
export const metadata: Metadata = {
  title: "Send an enquiry",
  robots: { index: false, follow: false },
};

export default async function EnquiryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const link = await withPublicLookup("slug", slug, (sys) => resolveSlug(sys, slug, "enquiry"));
  /* Unpublished and nonexistent are the same answer from outside. */
  if (!link) notFound();

  return <EnquiryView slug={link.slug} workspaceName={link.workspaceName} />;
}
