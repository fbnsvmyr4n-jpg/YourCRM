import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { confirmReturn, loadPayPage } from "@/server/pay/pay";
import { PayView } from "./PayView";

/**
 * An invoice on the public internet, with a way to pay it.
 *
 * No session. The token in the URL opens this one invoice and nothing else.
 * When Paystack sends the client back here it adds `reference`; that is
 * checked with Paystack before anything is believed.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Pay an invoice",
  robots: { index: false, follow: false },
};

export default async function PayPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ reference?: string }>;
}) {
  const { token } = await params;
  const { reference } = await searchParams;

  let notice: { tone: "good" | "bad"; text: string } | null = null;
  if (typeof reference === "string" && reference) {
    const out = await confirmReturn(token, reference);
    if (out.outcome === "paid" || out.outcome === "already_recorded") {
      notice = { tone: "good", text: "Payment received. Thank you — a receipt is on its way from Paystack." };
    } else if (out.outcome === "part_paid") {
      notice = { tone: "good", text: "Payment received. Part of this invoice is still outstanding." };
    } else if (out.outcome === "failed") {
      notice = { tone: "bad", text: out.message };
    }
  }

  const page = await loadPayPage(token);
  if (page.state === "not_found") notFound();

  return <PayView token={token} page={page} notice={notice} />;
}
