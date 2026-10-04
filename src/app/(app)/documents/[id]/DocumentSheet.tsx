"use client";

import Link from "next/link";
import { ArrowLeft, Printer } from "lucide-react";
import { formatMoney, type CurrencyCode } from "@/lib/money";
import { rateLabel, vatBreakdown } from "@/server/vat";
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

/** What Settings → Business says about the firm whose name is on the page. */
export type Letterhead = {
  address: string | null;
  phone: string | null;
  email: string | null;
  registrationNumber: string | null;
  vatNumber: string | null;
  vatRateBp: number;
  pricesIncludeVat: boolean;
};

export function DocumentSheet({
  doc,
  currency,
  payTo,
  business,
  letterhead,
  approvedBy,
  preparedBy,
}: {
  doc: Quote;
  currency: CurrencyCode;
  payTo: string | null;
  business: string;
  letterhead: Letterhead;
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

  /*
     The tax, if this business charges any.

     Worked out in `server/vat.ts` and nowhere else, so the printed sheet, the
     emailed copy and the online payment page cannot disagree by a cent — which
     is enough for a bookkeeper to send an invoice back.

     Null at a zero rate, and then not one word about VAT appears: a business
     that is not registered printing "VAT 0.00" invites exactly the wrong
     question from a client.
  */
  const vat =
    doc.kind === "purchase_order"
      ? /* NEVER on a purchase order. That is money going OUT, and the VAT on it
           is the SUPPLIER's to charge at their rate under their number — ours
           has nothing to do with it. Printing our 15% on an order would be
           telling a supplier what to invoice us, and would overstate a
           committed cost by the rate in our own figures. */
        null
      : vatBreakdown(doc.totalCents, letterhead.vatRateBp, letterhead.pricesIncludeVat);

  /* "Tax invoice" is the required heading in South Africa and reads correctly
     everywhere else; without a VAT number it would be a claim this business
     has not made, so the plain word stands. */
  const title =
    doc.kind === "invoice" && letterhead.vatNumber
      ? "Tax invoice"
      : (KIND_TITLE[doc.kind] ?? "Document");
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

  /*
     What this business has not told us about itself, said HERE.

     A workspace that has filled nothing in gets a clean document — a name, a
     date, the lines and the total, with no blank labels and no invented
     figures, which is right. The problem the empty-letterhead audit found is
     that it is also silent: somebody prints it and sends it to a client with no
     address on it, having never been told there was an address to add.

     Said at the moment of sending rather than on a settings screen nobody has
     opened, and `print:hidden` below, so the client never sees it — this is a
     note to the sender about their own paperwork, not part of the document.
  */
  const missing = [
    !letterhead.address && "your address",
    !letterhead.registrationNumber && "your company registration number",
    !letterhead.phone && !letterhead.email && "a phone number or email",
  ].filter(Boolean) as string[];

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

      {/* A note to the sender, never to the client: `print:hidden`. */}
      {missing.length > 0 && (
        <p
          className="mb-4 rounded-xl px-4 py-2.5 text-sm print:hidden"
          style={{ background: "var(--amber-soft)", color: "var(--amber)" }}
        >
          This document does not show {missing.join(", ")}.{" "}
          <Link href="/settings?s=business" className="focus-ring rounded font-semibold underline">
            Add them under Settings → Business
          </Link>{" "}
          and every document picks them up.
        </p>
      )}

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
          {/* The letterhead. Every line is omitted when the workspace has not
              supplied it — a document with a blank "VAT No:" on it reads as
              broken, and an invented one is worse than either. */}
          <div className="min-w-0 text-left @min-[520px]:text-right">
            {business && <p className="font-semibold">{business}</p>}
            {letterhead.address && (
              <p className="mt-1 whitespace-pre-line text-sm text-[#5a6478]">{letterhead.address}</p>
            )}
            {(letterhead.phone || letterhead.email) && (
              <p className="mt-1 text-sm text-[#5a6478]">
                {[letterhead.phone, letterhead.email].filter(Boolean).join(" · ")}
              </p>
            )}
            {letterhead.registrationNumber && (
              <p className="mt-1 text-xs text-[#8b94a7]">Reg. {letterhead.registrationNumber}</p>
            )}
            {letterhead.vatNumber && (
              <p className="text-xs text-[#8b94a7]">VAT {letterhead.vatNumber}</p>
            )}
            {doc.issuedOn && <p className="mt-2 text-sm text-[#5a6478]">{longDate(doc.issuedOn)}</p>}
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
            {/* The job's own reference, under its name.

                This is the line that lets a supplier's invoice find its way
                back to the work: the order they are holding says J-1004 and so
                does the job, so neither side has to match "the warehouse one,
                phase two" by description. Absent on work raised before jobs
                were numbered, rather than shown as a blank label. */}
            {doc.projectNumber && (
              <p className="font-mono text-xs text-[#8b94a7]">{doc.projectNumber}</p>
            )}
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
              {/* With no tax to show, one line — the figure the lines add up to.
                  With tax, three, because a client's bookkeeper has to be able
                  to read the amount before VAT, the VAT itself and what is
                  payable without doing any arithmetic of their own. */}
              {vat && (
                <>
                  <tr className="break-inside-avoid">
                    <td colSpan={2} />
                    <td className="pt-4 pl-2 text-right text-[#5a6478] @min-[520px]:pl-4">
                      Subtotal
                    </td>
                    <td className="pt-4 pl-2 text-right tabular-nums @min-[520px]:pl-4">
                      {money(vat.netCents)}
                    </td>
                  </tr>
                  <tr className="break-inside-avoid">
                    <td colSpan={2} />
                    <td className="pt-1 pl-2 text-right text-[#5a6478] @min-[520px]:pl-4">
                      VAT at {rateLabel(vat.rateBp)}
                    </td>
                    <td className="pt-1 pl-2 text-right tabular-nums @min-[520px]:pl-4">
                      {money(vat.vatCents)}
                    </td>
                  </tr>
                </>
              )}
              <tr className="break-inside-avoid">
                <td colSpan={2} />
                <td className="pt-4 pl-2 text-right font-semibold @min-[520px]:pl-4">Total</td>
                <td className="pt-4 pl-2 text-right text-base font-bold tabular-nums @min-[520px]:pl-4 @min-[520px]:text-lg">
                  {/* The gross when there is VAT: the one number the other side
                      actually pays. Showing the pre-tax figure here is how a
                      client ends up transferring 15% less than the invoice. */}
                  {money(vat ? vat.grossCents : doc.totalCents)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* Nothing about VAT above when the workspace charges none. A business
            that is not registered printing "VAT 0.00" invites exactly the wrong
            question, and an invented number would be worse than either. */}

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
