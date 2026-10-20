import { creditedFor } from "./repos/credits";
import { getSettings } from "./repos/settings";
import { nextDocumentNumber } from "./document-ledger";
import { payableCents } from "./vat";
import type { TenantQuery } from "./tenant";

/**
 * Taking back part of a bill.
 *
 * A client was overcharged, or returned goods, or was billed for work that did
 * not happen. Until now there was nothing to express that: the only ways to
 * correct an invoice were to edit it — which rewrites a document the client
 * already has — or to cancel it and raise another, which loses the history of
 * what was actually agreed.
 *
 * ── Raised against an invoice, never on its own ───────────────────────────
 *
 * A credit note with no invoice behind it is a number with nothing to reduce.
 * It is created from one, inherits its client, and names it on the face of the
 * document so the pair can be matched by whoever receives them.
 *
 * ── Why it copies the lines ───────────────────────────────────────────────
 *
 * Starting from the invoice's own lines and deleting what is not being
 * credited is how somebody actually works: "they are not paying for the
 * scaffold hire". Starting from an empty document means retyping descriptions
 * and rates that already exist, which is the step where a credit note ends up
 * citing a different rate from the invoice it corrects.
 *
 * It is a DRAFT. Creating it and giving it to the client are two decisions,
 * and nothing is taken off what they owe until it is issued — see
 * `repos/credits`.
 */

export type CreditResult =
  | { creditNoteId: string; number: string; forInvoice: string; totalCents: number }
  | { error: string };

export async function raiseCreditNote(q: TenantQuery, invoiceId: string): Promise<CreditResult> {
  const invoice = await q.one<{
    id: string;
    number: string;
    deal_id: string;
    party: string | null;
    party_contact_id: string | null;
    status: string;
  }>(
    `SELECT id, number, deal_id, party, party_contact_id, status
       FROM documents
      WHERE sub_account_id = $1 AND id = $2 AND kind = 'invoice' AND deleted_at IS NULL`,
    [q.ctx.subAccountId, invoiceId]
  );
  if (!invoice) return { error: "That invoice no longer exists." };

  /* Nothing to take back off a bill that was never given. Said plainly rather
     than producing a credit note against a draft, which would be a correction
     to a document the client has not seen. */
  if (invoice.status === "draft") {
    return {
      error: `${invoice.number} is still a draft. Change it directly — a credit note is for an invoice the client already has.`,
    };
  }

  const lines = await q.rows<{
    description: string;
    quantity: string;
    unit_cents: string;
    position: number;
    price_item_id: string | null;
  }>(
    `SELECT description, quantity::text AS quantity, unit_cents::text AS unit_cents,
            position, price_item_id
       FROM document_lines
      WHERE sub_account_id = $1 AND document_id = $2
      ORDER BY position ASC`,
    [q.ctx.subAccountId, invoiceId]
  );
  if (lines.length === 0) return { error: `${invoice.number} has no lines to credit.` };

  /*
     Already credited in full, so there is nothing left to take back.

     Checked against what the client OWES rather than the line total, for the
     same reason everything else here does: on a workspace charging VAT on top,
     the two differ by the tax and the wrong one would let a second credit note
     be raised for the difference.
  */
  const settings = await getSettings(q);
  const lineTotal = lines.reduce(
    (sum, l) => sum + Math.round(Number(l.quantity) * Number(l.unit_cents)),
    0
  );
  const payable = payableCents(lineTotal, settings.vatRateBp, settings.pricesIncludeVat);
  const already = await creditedFor(q, invoiceId);
  if (already >= payable) {
    return { error: `${invoice.number} has already been credited in full.` };
  }

  const number = await nextDocumentNumber(q, "credit_note", "CN");
  const creditNoteId = `cn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  await q.attempt(() =>
    q.rows(
      `INSERT INTO documents
         (id, sub_account_id, deal_id, kind, number, status, party, party_contact_id,
          credits_document_id, notes)
       VALUES ($1, $2, $3, 'credit_note', $4, 'draft', $5, $6, $7, $8)`,
      [
        creditNoteId,
        q.ctx.subAccountId,
        invoice.deal_id,
        number,
        invoice.party,
        invoice.party_contact_id,
        invoiceId,
        `Credit against ${invoice.number}.`,
      ]
    )
  );

  for (const [i, line] of lines.entries()) {
    await q.rows(
      /* The price item travels too. It is what a later slice will need to put
         goods back on the shelf, and recomputing it from the description would
         mean matching a name two suppliers can share. */
      `INSERT INTO document_lines
         (id, sub_account_id, document_id, description, quantity, unit_cents, position, price_item_id)
       VALUES ($1, $2, $3, $4, $5::numeric, $6::bigint, $7, $8)`,
      [
        `dl-${creditNoteId}-${i}`,
        q.ctx.subAccountId,
        creditNoteId,
        line.description,
        line.quantity,
        line.unit_cents,
        line.position,
        line.price_item_id,
      ]
    );
  }

  return { creditNoteId, number, forInvoice: invoice.number, totalCents: lineTotal };
}
