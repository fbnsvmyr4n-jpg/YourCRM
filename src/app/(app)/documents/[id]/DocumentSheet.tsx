"use client";

import Link from "next/link";
import { ArrowLeft, Printer } from "lucide-react";
import { formatMoney, type CurrencyCode } from "@/lib/money";
import type { Quote } from "@/server/repos/quotes";

/**
 * A document on a page, as the person receiving it will read it.
 *
 * Until now a client got an email; this is the thing they can file. It is a
 * sheet of paper rather than an app screen, and the browser's own print dialogue
 * turns it into a PDF — which is why there is no PDF library here. A renderer
 * would mean a second layout, in a second language, kept in step with this one
 * by hand, to produce what the browser already produces from the markup below.
 *
 * WHAT IT DELIBERATELY DOES NOT SHOW. A VAT number, a company registration
 * number and a postal address are not held anywhere in this product, so they are
 * not printed and nothing here implies them. An invented VAT number on a
 * document somebody hands to their accountant is far worse than an absent one.
 * A VAT-registered business needs those fields before this sheet is usable as a
 * tax document — that is an addition to Settings, not to this file.
 */

const KIND_TITLE: Record<string, string> = {
  quote: "Quotation",
  purchase_order: "Purchase order",
  invoice: "Invoice",
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * "2026-10-01" → "1 October 2026".
 *
 * By hand, like money and for the same reason: this component renders once on
 * the server and again in the browser, and `Intl` does not give the two the same
 * answer — a date that visibly changes as the page loads is a hydration
 * mismatch on the one screen where every character is meant to be fixed.
 */
function longDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month} ${m[1]}` : iso;
}

export function DocumentSheet({
  doc,
  currency,
  payTo,
  business,
  approvedBy,
  preparedBy,
}: {
  doc: Quote;
  currency: CurrencyCode;
  payTo: string | null;
  business: string;
  /** Who said yes, from the document itself — not whoever is looking at it. */
  approvedBy: string | null;
  preparedBy: string | null;
}) {
  /* To the cent, always, and on every line. This is a figure somebody signs:
     R42,001.75 shown as R42,002 is 25c the client's copy will not agree with. */
  const money = (cents: number) => formatMoney(cents, currency, "cents");
  /* 3.5 stays 3.5 and 2.000 shows as 2 — the column keeps three places, and
     printing them all makes a whole number look like a measurement. */
  const qty = (n: number) => String(Number(n.toFixed(3)));

  const title = KIND_TITLE[doc.kind] ?? "Document";
  const isOrder = doc.kind === "purchase_order";
  /*
     A document that is no longer live says so ON THE PAPER.

     Every other status is shown beside the controls, on screen only, because a
     client has no use for our word for where their quotation has got to. These
     two are different: a cancelled quotation printed exactly like a live one is
     an old price, back in front of a client, with nothing on it to say so. The
     word has to survive being printed and handed over.
  */
  const voided =
    doc.status === "cancelled" ? "Cancelled" : doc.status === "declined" ? "Declined" : null;

  return (
    <div className="mx-auto max-w-[860px] animate-fade-up pb-10 print:pb-0">
      {/* The controls, and nothing else on screen that is not on the paper. */}
      <div className="mb-4 flex items-center justify-between gap-3 print:hidden">
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
          <Link
            href={isOrder ? "/purchase-orders" : "/quotes"}
            className="focus-ring inline-flex items-center gap-2 rounded-lg py-1 text-sm text-muted hover:text-[var(--text)]"
          >
            <ArrowLeft className="h-4 w-4" />
            {isOrder ? "All purchase orders" : "All quotes"}
          </Link>
          {/* The way back to the work. The sheet itself names the job but does
              not link to it — on paper a link is nothing, and a client reading
              this has no job to open. */}
          <Link
            href={`/projects/${doc.dealId}?tab=documents`}
            className="focus-ring truncate rounded-lg py-1 text-sm text-muted hover:text-[var(--text)]"
          >
            Open job
          </Link>
          {/* Where it has got to — for us, not for them. It sits out here with
              the controls rather than on the sheet, because "awaiting approval"
              is our word for our process and means nothing to a client holding
              the printed copy. */}
          <span className="truncate text-sm capitalize text-faint">
            {doc.status.replace(/_/g, " ")}
          </span>
        </div>
        <button
          type="button"
          onClick={() => window.print()}
          className="btn-accent focus-ring inline-flex min-h-[44px] shrink-0 items-center gap-2 whitespace-nowrap rounded-xl px-4 text-sm font-semibold"
        >
          <Printer className="h-4 w-4" />
          {/* Short on a phone. The long label wrapped to two lines there and
              pushed the row below it, for a button whose icon already says what
              it does. */}
          <span className="@min-[520px]:hidden">Print</span>
          <span className="hidden @min-[520px]:inline">Print or save as PDF</span>
        </button>
      </div>

      <article className="doc-sheet rounded-2xl p-5 @min-[520px]:p-8 @min-[760px]:p-10 print:rounded-none print:p-0">
        <header className="flex flex-wrap items-start justify-between gap-6 border-b border-[#e3e7ef] pb-6">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">
              {title}
              {voided && (
                <span className="ml-3 align-middle rounded-md border border-[#c0392b] px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-[#c0392b]">
                  {voided}
                </span>
              )}
            </h1>
            <p className="mt-1 text-sm text-[#5a6478]">{doc.number}</p>
          </div>
          <div className="min-w-0 text-left sm:text-right">
            {business && <p className="font-semibold">{business}</p>}
            {doc.issuedOn && <p className="mt-1 text-sm text-[#5a6478]">{longDate(doc.issuedOn)}</p>}
          </div>
        </header>

        <div className="flex flex-wrap gap-x-12 gap-y-5 py-6 text-sm">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8b94a7]">
              {isOrder ? "To" : "For"}
            </p>
            <p className="mt-1 font-medium">{doc.party ?? "—"}</p>
            {/* The address it was sent to, so a query about "did you get it"
                can be settled from the client's own copy. */}
            {doc.partyEmail && <p className="text-[#5a6478]">{doc.partyEmail}</p>}
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8b94a7]">Job</p>
            <p className="mt-1 font-medium">{doc.projectTitle}</p>
          </div>
        </div>

        {/*
           All four columns fit on a phone rather than scrolling sideways.

           The first build gave the table a 420px floor and let it scroll inside
           its own box, which on a 375px screen put the Amount column and the
           TOTAL off the right-hand edge — the two figures the page exists to
           show, hidden behind a gesture nothing on screen suggested. So the type
           steps down instead and the description wraps: narrower, and all of it
           on the screen.
        */}
        <div className="-mx-1 px-1">
          <table className="w-full border-collapse text-xs @min-[520px]:text-sm">
            <thead>
              <tr className="border-b border-[#e3e7ef] text-left text-[11px] uppercase tracking-wide text-[#8b94a7]">
                <th className="pb-2 font-semibold">Description</th>
                <th className="pb-2 pl-2 text-right font-semibold @min-[520px]:pl-4">Qty</th>
                <th className="pb-2 pl-2 text-right font-semibold @min-[520px]:pl-4">Unit</th>
                <th className="pb-2 pl-2 text-right font-semibold @min-[520px]:pl-4">Amount</th>
              </tr>
            </thead>
            <tbody>
              {doc.lines.map((l) => (
                /* `break-inside-avoid`: a line split across two sheets is how a
                   printed total stops matching the lines above it. */
                <tr key={l.id} className="break-inside-avoid border-b border-[#edf0f6]">
                  <td className="py-2.5 pr-2 @min-[520px]:pr-4">{l.description}</td>
                  <td className="py-2.5 pl-2 text-right tabular-nums @min-[520px]:pl-4">{qty(l.quantity)}</td>
                  <td className="py-2.5 pl-2 text-right tabular-nums @min-[520px]:pl-4">{money(l.unitCents)}</td>
                  <td className="py-2.5 pl-2 text-right font-medium tabular-nums @min-[520px]:pl-4">{money(l.totalCents)}</td>
                </tr>
              ))}
              {doc.lines.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-4 text-[#8b94a7]">
                    This {title.toLowerCase()} has no lines on it yet.
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr className="break-inside-avoid">
                <td colSpan={2} />
                <td className="pt-4 pl-2 text-right font-semibold @min-[520px]:pl-4">Total</td>
                <td className="pt-4 pl-2 text-right text-base font-bold tabular-nums @min-[520px]:pl-4 @min-[520px]:text-lg">
                  {money(doc.totalCents)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* No VAT line, and no "incl. VAT" on the total. The workspace holds
            neither a VAT number nor a rate, so either would be a tax claim made
            on nothing. */}

        {doc.notes && (
          <p className="mt-8 whitespace-pre-line border-t border-[#e3e7ef] pt-6 text-sm leading-relaxed text-[#43506a]">
            {doc.notes}
          </p>
        )}

        {doc.kind === "invoice" && payTo && (
          <div className="mt-8 break-inside-avoid border-t border-[#e3e7ef] pt-6 text-sm">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8b94a7]">
              How to pay
            </p>
            <p className="mt-1 whitespace-pre-line text-[#43506a]">{payTo}</p>
          </div>
        )}

        {/* Who stands behind it. On an approved quotation that is the person who
            approved it, read off the document — so a client querying a price six
            weeks later gets the same name the emailed copy gave them, not
            whoever happened to open this page. */}
        <footer className="mt-10 border-t border-[#e3e7ef] pt-4 text-xs text-[#8b94a7]">
          {approvedBy
            ? `Approved by ${approvedBy}${business ? `, ${business}` : ""}.`
            : preparedBy
              ? `Prepared by ${preparedBy}${business ? `, ${business}` : ""}.`
              : business}
        </footer>
      </article>
    </div>
  );
}
