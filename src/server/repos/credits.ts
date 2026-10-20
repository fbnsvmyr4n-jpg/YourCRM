import { getSettings } from "./settings";
import { payableCents } from "../vat";
import type { TenantQuery } from "../tenant";

/**
 * How much of an invoice has been taken back.
 *
 * A credit note is a document like any other — its amount is the sum of its
 * lines, exactly as a quotation's or an invoice's is, so there is no second
 * way of totalling a document to drift from the first.
 *
 * ── Why this is its own module ────────────────────────────────────────────
 *
 * Four places work out what an invoice owes: the ledger, the project screen,
 * the public pay page, and the rule that settles it. Each of them now has to
 * subtract credits, and each of them loads its documents differently — one
 * row, one project, one ledger, one token. A single query shaped for one
 * invoice and a single query shaped for many is the smallest thing that keeps
 * all four saying the same number.
 *
 * ── What counts ──────────────────────────────────────────────────────────
 *
 * A credit note that has been issued. A DRAFT one does not reduce anything:
 * it is somebody part-way through typing, and an invoice whose outstanding
 * figure moved because of an unfinished document would be a figure that moves
 * back. Cancelled ones do not count either — that is what cancelling means.
 */

/** Statuses at which a credit note has actually been given to the client. */
const ISSUED = ["approved", "sent", "accepted", "paid"] as const;

/**
 * ── WHY THIS RETURNS THE GROSS, AND NOT THE SUM OF THE LINES ──────────────
 *
 * A credit note is a tax document like the invoice it corrects. Its printed
 * sheet adds VAT exactly as the invoice does: R15,000 of lines is R17,250 on
 * the paper the client is holding.
 *
 * Returning the line sum instead measured credits NET against an invoice
 * measured GROSS, and the two are not the same number on any workspace
 * charging tax on top. The effect, found by crediting a real invoice in the
 * running app: a client holding a credit note for R17,250 against an invoice
 * for R17,250 was still shown as owing R2,250 — the VAT on a charge that had
 * been taken back in full. That gap would have been chased, and the money was
 * never owed.
 *
 * So each credit note is totalled the same way its own sheet totals it, and
 * only then are they added up. Per document rather than over the whole pile,
 * because a document's total is a fact about that document — which is also how
 * the rounding stays identical to the paper.
 */
async function grossOf(q: TenantQuery, invoiceIds: readonly string[]) {
  const settings = await getSettings(q);
  const rows = await q.rows<{ invoice_id: string; note_id: string; lines: string }>(
    `SELECT cn.credits_document_id AS invoice_id, cn.id AS note_id,
            COALESCE(SUM(ROUND(l.quantity * l.unit_cents)), 0)::bigint::text AS lines
       FROM documents cn
       JOIN document_lines l
         ON l.document_id = cn.id AND l.sub_account_id = cn.sub_account_id
      WHERE cn.sub_account_id = $1
        AND cn.credits_document_id = ANY($2::text[])
        AND cn.kind = 'credit_note'
        AND cn.deleted_at IS NULL
        AND cn.status = ANY($3::text[])
      GROUP BY cn.credits_document_id, cn.id`,
    [q.ctx.subAccountId, [...invoiceIds], [...ISSUED]]
  );

  const out: Record<string, number> = {};
  for (const r of rows) {
    const gross = payableCents(Number(r.lines), settings.vatRateBp, settings.pricesIncludeVat);
    out[r.invoice_id] = (out[r.invoice_id] ?? 0) + gross;
  }
  return out;
}

/** Credited against one invoice, in cents — what the client no longer owes. */
export async function creditedFor(q: TenantQuery, invoiceId: string): Promise<number> {
  return (await grossOf(q, [invoiceId]))[invoiceId] ?? 0;
}

/**
 * Credited against each of many invoices, keyed by invoice.
 *
 * One query for a whole ledger. Asked per row it would be forty round trips to
 * answer a question that is almost always "nothing", on a screen somebody
 * opens to scan.
 *
 * Invoices with no credits are ABSENT rather than zero: the caller knows which
 * invoices it asked about, and this knows only what has been credited.
 */
export async function creditedForMany(
  q: TenantQuery,
  invoiceIds: readonly string[]
): Promise<Record<string, number>> {
  if (invoiceIds.length === 0) return {};
  return grossOf(q, invoiceIds);
}
