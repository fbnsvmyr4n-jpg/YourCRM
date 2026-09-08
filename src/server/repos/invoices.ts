import type { TenantQuery } from "../tenant";

/**
 * Invoices, read for sending and marked once they have gone.
 *
 * Separate from `repos/quotes.ts` on purpose. The two share a table and almost
 * nothing else: a quotation is a price somebody may still argue with and needs
 * a named approver before it leaves, while an invoice is a demand for payment
 * against work already agreed. Folding them into one module would mean every
 * function growing a `kind` argument and every caller having to remember which
 * rules applied — which is how a quotation ends up sent under an invoice's
 * rules, or the reverse.
 */

export type InvoiceLine = {
  description: string;
  quantity: number;
  unitCents: number;
  totalCents: number;
};

export type Invoice = {
  id: string;
  number: string;
  status: string;
  projectTitle: string;
  party: string | null;
  /** Read live from the contact record, never copied onto the document. */
  partyEmail: string | null;
  dueOn: string | null;
  notes: string | null;
  sentAt: string | null;
  /** How the client should pay, from the workspace's own settings. */
  payTo: string | null;
  lines: InvoiceLine[];
  totalCents: number;
};

/**
 * One invoice, with everything the email needs.
 *
 * The recipient's address comes from the CONTACT rather than the document, the
 * same way quotations do it: an address copied onto a document at the moment
 * it was raised is one that goes stale the first time somebody changes their
 * email, and a bill sent to a dead address is a bill nobody pays.
 */
export async function findInvoice(q: TenantQuery, documentId: string): Promise<Invoice | null> {
  const doc = await q.one<{
    id: string;
    number: string;
    status: string;
    project_title: string;
    party: string | null;
    party_email: string | null;
    due_on: string | null;
    notes: string | null;
    sent_at: Date | null;
    pay_to: string | null;
  }>(
    `SELECT d.id, d.number, d.status, deal.title AS project_title, d.party,
            c.email AS party_email, d.due_on::text AS due_on, d.notes, d.sent_at,
            s.invoice_pay_to AS pay_to
       FROM documents d
       JOIN deals deal ON deal.id = d.deal_id AND deal.sub_account_id = d.sub_account_id
       LEFT JOIN contacts c
              ON c.id = d.party_contact_id AND c.sub_account_id = d.sub_account_id
             AND c.deleted_at IS NULL
       LEFT JOIN settings s ON s.sub_account_id = d.sub_account_id
      WHERE d.sub_account_id = $1 AND d.id = $2 AND d.kind = 'invoice' AND d.deleted_at IS NULL`,
    [q.ctx.subAccountId, documentId]
  );
  if (!doc) return null;

  const lines = await q.rows<{
    description: string;
    quantity: string;
    unit_cents: string;
    total_cents: string;
  }>(
    `SELECT description, quantity::text AS quantity, unit_cents::text AS unit_cents,
            ROUND(quantity * unit_cents)::bigint::text AS total_cents
       FROM document_lines
      WHERE sub_account_id = $1 AND document_id = $2
      ORDER BY position ASC, id ASC`,
    [q.ctx.subAccountId, documentId]
  );

  const mapped = lines.map((l) => ({
    description: l.description,
    quantity: Number(l.quantity),
    unitCents: Number(l.unit_cents),
    totalCents: Number(l.total_cents),
  }));

  return {
    id: doc.id,
    number: doc.number,
    status: doc.status,
    projectTitle: doc.project_title,
    party: doc.party,
    partyEmail: doc.party_email,
    dueOn: doc.due_on,
    notes: doc.notes,
    sentAt: doc.sent_at ? doc.sent_at.toISOString() : null,
    payTo: doc.pay_to,
    lines: mapped,
    totalCents: mapped.reduce((n, l) => n + l.totalCents, 0),
  };
}

/**
 * Record that an invoice has gone.
 *
 * Guarded on `sent_at IS NULL`, so two presses arriving together produce one
 * send. The status moves to `sent` in the same statement — a row that claimed
 * to be sent while its status said draft would make every count on the project
 * screen disagree with the document itself.
 */
export async function markInvoiceSent(q: TenantQuery, documentId: string): Promise<boolean> {
  const row = await q.one<{ id: string }>(
    `UPDATE documents
        SET status = 'sent', sent_at = now(), updated_at = now()
      WHERE sub_account_id = $1 AND id = $2 AND kind = 'invoice'
        AND deleted_at IS NULL AND sent_at IS NULL
      RETURNING id`,
    [q.ctx.subAccountId, documentId]
  );
  return Boolean(row);
}
