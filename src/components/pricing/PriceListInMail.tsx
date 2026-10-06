"use client";

import Link from "next/link";
import { AlertTriangle, Check, Truck } from "lucide-react";
import { useCanHandleMoney } from "@/components/shell/Abilities";
import type { SupplierListInMail } from "@/server/supplier-mail";
import type { PriceListLoad } from "@/data/price-loads";

/**
 * "This looks like Stone Yard's price list."
 *
 * Shown on a message that arrived from a supplier and parses as a table. The
 * work it removes is the part that was actually costing time: noticing the
 * email, opening it, selecting the right block of text, going to another
 * screen and pasting it.
 *
 * What it does NOT remove is the looking. It carries the text to the price
 * list and opens the same preview a paste opens — because every quotation this
 * business sends is built from these numbers, and a message is a thing anyone
 * can send. The reasoning is written out in `server/supplier-mail.ts`.
 *
 * It says what it found and why it is offering, so somebody deciding whether
 * to trust it can see what was actually matched rather than take the card's
 * word for it.
 */
export function PriceListInMail({
  found,
  messageId,
  loaded = null,
}: {
  found: SupplierListInMail;
  messageId: string;
  /**
   * The load this message has already had, if any.
   *
   * Without this the card goes on saying "Review and load it" over a list that
   * is already in the price list — so the obedient thing to do is press it
   * again, and the screen gives no sign that anything happened the first time.
   * With automatic loading that is the common case rather than the odd one: the
   * machine loads it before anybody opens the message.
   */
  loaded?: PriceListLoad | null;
}) {
  const canWrite = useCanHandleMoney();
  if (!canWrite) return null;

  if (loaded) {
    const did = [
      loaded.added && `${loaded.added} added`,
      loaded.repriced && `${loaded.repriced} repriced`,
      loaded.unchanged && `${loaded.unchanged} unchanged`,
    ]
      .filter(Boolean)
      .join(", ");

    return (
      <div className="mt-3 rounded-xl px-3.5 py-3" style={{ background: "var(--green-soft)" }}>
        <p className="flex items-center gap-2 text-sm font-semibold" style={{ color: "var(--green)" }}>
          <Check className="h-4 w-4 shrink-0" aria-hidden />
          {loaded.supplierName}&rsquo;s prices were loaded from this
        </p>
        <p className="mt-1 text-xs text-muted">
          {did || "Nothing in it had changed"}
          {/* WHO, and "nobody" said as itself rather than left blank. A price
              that moved without anybody pressing anything is exactly the fact
              somebody needs when a quotation comes out wrong, and a missing
              name reads as an oversight rather than as an answer. */}
          {loaded.loadedByName ? ` · loaded by ${loaded.loadedByName}` : " · loaded automatically"}
          {". "}
          <Link href="/pricing" className="underline underline-offset-2 hover:text-accent">
            See the price list
          </Link>
        </p>
      </div>
    );
  }

  const rows = found.lines.length;

  return (
    <div
      className="mt-3 rounded-xl px-3.5 py-3"
      style={{ background: "var(--accent-soft)" }}
    >
      <p className="flex items-center gap-2 text-sm font-semibold text-accent">
        <Truck className="h-4 w-4 shrink-0" aria-hidden />
        This looks like {found.supplierName}&rsquo;s price list
      </p>

      <p className="mt-1 text-xs text-muted">
        {rows} price{rows === 1 ? "" : "s"} in it
        {/* Only the lines that TRIED to be a price and failed are called out.
            The greeting and the sign-off are said separately and calmly — an
            alarming number on every supplier email is how a warning stops
            being read. */}
        {found.unread > 0 &&
          `, and ${found.unread} line${found.unread === 1 ? "" : "s"} we could not read`}
        . {found.because}.
        {found.prose > 0 && (
          <span className="text-faint">
            {" "}
            The {found.prose} other line{found.prose === 1 ? "" : "s"} carried no price and{" "}
            {found.prose === 1 ? "was" : "were"} left alone.
          </span>
        )}
      </p>

      {/* A link, not a button. Nothing is written from here — the price list
          opens with this message's text in the box, and the same preview and
          the same confirm decide what happens to it.

          The MESSAGE's id travels, not the list. A price list does not fit in
          a URL, and the text is then read back from the record rather than
          from something a browser handed over — which is also why a stale or
          hand-edited link cannot smuggle prices in. */}
      {/* Why this one did not load itself, for a supplier whose lists normally
          do. Somebody looking at this button with the switch on has exactly one
          question, and the answer also points them at the line worth staring
          at. Absent when the switch is off: there is nothing to explain,
          because nothing was expected. */}
      {found.heldBecause && (
        <p className="mt-2 flex items-start gap-1.5 text-xs font-medium" style={{ color: "var(--amber)" }}>
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          Held for you: {found.heldBecause}.
        </p>
      )}

      <Link
        href={`/pricing?fromMessage=${encodeURIComponent(messageId)}`}
        className="btn-accent focus-ring mt-2.5 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold"
      >
        Review and load it
      </Link>
    </div>
  );
}
