import type { TenantQuery } from "./tenant";

/**
 * The invoice a job has already earned.
 *
 * Invoicing was in the data model from the day documents were built — the kind
 * is allowed, the `paid` status exists, the id prefix is there — and none of it
 * was reachable. The dropdown offered two kinds of three, nothing could be
 * sent, and no screen said what had been billed. The schema's own note promised
 * that "invoicing later is a status transition, not a new model"; this is that
 * transition, finally written.
 *
 * The lines come from the quotation the client ACCEPTED, unchanged. That is the
 * point rather than a shortcut: an invoice that restates the agreed figures is
 * one nobody has to reconcile, and re-typing them is how a number drifts
 * between what was sold and what was billed. It also means the stage links
 * come along, so per-stage money keeps working without anybody re-filing
 * anything.
 */

/** In preference order. Only a quotation the client actually agreed to. */
export const INVOICEABLE_STATUSES = ["accepted", "paid"] as const;

export type RaiseResult = {
  error?: string;
  invoiceId?: string;
  number?: string;
  fromQuote?: string;
  totalCents?: number;
};

/**
 * The next invoice number, continuing whatever this workspace already uses.
 *
 * Same approach as quotations: read the highest number that looks like ours and
 * add one, rather than counting rows. A count is wrong the moment anything is
 * deleted, and it would hand two people the same number under load.
 */
export async function nextInvoiceNumber(q: TenantQuery): Promise<string> {
  const rows = await q.rows<{ number: string }>(
    `SELECT number FROM documents
      WHERE sub_account_id = $1 AND kind = 'invoice' AND number ~ '^INV-[0-9]+$'`,
    [q.ctx.subAccountId]
  );
  const highest = rows.reduce((max, r) => Math.max(max, Number(r.number.slice(4))), 1000);
  return `INV-${highest + 1}`;
}

/**
 * Raise an invoice for the work a client has agreed to.
 *
 * Refuses when one already exists for that quotation. Billing the same
 * agreement twice is the single worst thing this feature could do — a client
 * receiving two demands for one job is a phone call and a lost afternoon, and
 * "did we already invoice this" is not a question the screen could answer
 * before. The link between the two is the document line: an invoice line
 * carries the same `project_task_id` as the quote line it came from, so a
 * second invoice for the same stages is visible rather than merely likely.
 */
export async function raiseInvoiceFromQuote(
  q: TenantQuery,
  dealId: string
): Promise<RaiseResult> {
  const quote = await q.one<{ id: string; number: string; party: string | null; party_contact_id: string | null; notes: string | null }>(
    `SELECT d.id, d.number, d.party, d.party_contact_id, d.notes
       FROM documents d
      WHERE d.sub_account_id = $1
        AND d.deal_id = $2
        AND d.kind = 'quote'
        AND d.deleted_at IS NULL
        AND d.status = ANY($3::text[])
      ORDER BY array_position($3::text[], d.status), d.created_at DESC
      LIMIT 1`,
    [q.ctx.subAccountId, dealId, [...INVOICEABLE_STATUSES]]
  );
  if (!quote) {
    return {
      error:
        "There is no accepted quotation on this project yet. An invoice is raised from work the client has agreed to — mark the quotation accepted and it can be billed.",
    };
  }

  const existing = await q.one<{ number: string }>(
    `SELECT number FROM documents
      WHERE sub_account_id = $1 AND deal_id = $2 AND kind = 'invoice' AND deleted_at IS NULL
      LIMIT 1`,
    [q.ctx.subAccountId, dealId]
  );
  if (existing) {
    return {
      error: `${existing.number} has already been raised for this project. Open it rather than billing the same work twice.`,
    };
  }

  const lines = await q.rows<{
    description: string;
    quantity: string;
    unit_cents: string;
    position: number;
    project_task_id: string | null;
  }>(
    `SELECT description, quantity::text AS quantity, unit_cents::text AS unit_cents,
            position, project_task_id
       FROM document_lines
      WHERE sub_account_id = $1 AND document_id = $2
      ORDER BY position ASC`,
    [q.ctx.subAccountId, quote.id]
  );
  if (lines.length === 0) return { error: `${quote.number} has no lines to bill.` };

  const number = await nextInvoiceNumber(q);
  const invoiceId = `inv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  /* Raised as a DRAFT. Creating it and sending it are two decisions, and
     collapsing them would mean one press put a demand for money in a client's
     inbox — with no chance to set the due date or check the figures first. */
  await q.attempt(() =>
    q.rows(
      `INSERT INTO documents
         (id, sub_account_id, deal_id, kind, number, status, party, party_contact_id, notes)
       VALUES ($1, $2, $3, 'invoice', $4, 'draft', $5, $6, $7)`,
      [invoiceId, q.ctx.subAccountId, dealId, number, quote.party, quote.party_contact_id, quote.notes]
    )
  );

  let totalCents = 0;
  for (const [i, line] of lines.entries()) {
    /* The stage link is copied, not recomputed. It is what lets a stage show
       what was billed against it beside what was quoted and committed. */
    await q.rows(
      `INSERT INTO document_lines
         (id, sub_account_id, document_id, description, quantity, unit_cents, position, project_task_id)
       VALUES ($1, $2, $3, $4, $5::numeric, $6::bigint, $7, $8)`,
      [
        `dl-${invoiceId}-${i}`,
        q.ctx.subAccountId,
        invoiceId,
        line.description,
        line.quantity,
        line.unit_cents,
        line.position,
        line.project_task_id,
      ]
    );
    totalCents += Math.round(Number(line.quantity) * Number(line.unit_cents));
  }

  return { invoiceId, number, fromQuote: quote.number, totalCents };
}
