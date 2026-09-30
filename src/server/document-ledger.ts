import type { DocumentKind, DocumentStatus } from "./repos/projects";
import { orderCounts, quoteCounts } from "./stage-money";
import type { TenantQuery } from "./tenant";

/**
 * Every quotation, or every purchase order, across all of a workspace's jobs.
 *
 * The project screen answers "what paperwork does THIS job have". The question
 * this answers is the other one — "where is that quote" — asked without
 * remembering which job it was on, and "what have we committed to this month"
 * asked across all of them.
 *
 * THE TOTAL IS COMPUTED IN THE DATABASE, never in JavaScript. `quantity` is a
 * decimal and `unit_cents` an integer, and multiplying them in JS is how 3.5
 * days at R12,000 became R58,000 once already in this product. `ROUND(quantity
 * * unit_cents)` is the same expression the project screen and the invoice
 * builder use, so a figure cannot differ depending on which page you read it
 * on.
 */

export type LedgerRow = {
  id: string;
  number: string;
  status: DocumentStatus;
  /** Who it is for: the client on a quotation, the supplier on an order. */
  party: string | null;
  issuedOn: string | null;
  sentAt: string | null;
  projectId: string;
  projectTitle: string;
  lineCount: number;
  totalCents: number;
  /** Carried for editing. One value per row, unlike the lines. */
  notes: string | null;
  partyEmail: string | null;
  /** Whether this document's money is counted — see `stage-money.ts`. */
  counts: boolean;
};

export type Ledger = {
  rows: LedgerRow[];
  /**
   * The total of the documents that COUNT, and of those that do not.
   *
   * Two figures rather than one, for the same reason the project header keeps
   * quoted and committed apart from invoiced: a heading of "R55,000 quoted"
   * over a list containing a declined quotation is a number the reader cannot
   * reconcile with what is in front of them. What counts is stated, and the
   * rest is named as what it is.
   */
  countedCents: number;
  notCountedCents: number;
};

/** What "counts" means, per kind — the single definition, from `stage-money`. */
export function documentCounts(kind: DocumentKind, status: DocumentStatus): boolean {
  if (kind === "quote") return quoteCounts(status);
  if (kind === "purchase_order") return orderCounts(status);
  /* An invoice is the same money as the quotation it bills; this ledger is not
     where that question is answered. */
  return false;
}

export async function documentLedger(q: TenantQuery, kind: DocumentKind): Promise<Ledger> {
  const rows = await q.rows<{
    id: string;
    number: string;
    status: DocumentStatus;
    party: string | null;
    issued_on: string | null;
    sent_at: Date | null;
    notes: string | null;
    party_email: string | null;
    project_id: string;
    project_title: string;
    line_count: string;
    total_cents: string;
  }>(
    `SELECT d.id, d.number, d.status, d.party,
            d.issued_on::text AS issued_on, d.sent_at, d.notes,
            COALESCE(d.party_email, c.email) AS party_email,
            d.deal_id AS project_id, deal.title AS project_title,
            COALESCE(lines.n, 0)::text AS line_count,
            COALESCE(lines.total, 0)::bigint::text AS total_cents
       FROM documents d
       JOIN deals deal
         ON deal.id = d.deal_id AND deal.sub_account_id = d.sub_account_id
        AND deal.deleted_at IS NULL
       /* The address it would actually be sent to — the document's own if it
          has one, otherwise the contact's. The same precedence the send path
          uses, so the screen shows where it is going, not where it might. */
       LEFT JOIN contacts c
              ON c.id = d.party_contact_id AND c.sub_account_id = d.sub_account_id
             AND c.deleted_at IS NULL
       LEFT JOIN LATERAL (
         SELECT count(*) AS n, SUM(ROUND(l.quantity * l.unit_cents)) AS total
           FROM document_lines l
          WHERE l.sub_account_id = d.sub_account_id AND l.document_id = d.id
       ) lines ON TRUE
      WHERE d.sub_account_id = $1 AND d.kind = $2 AND d.deleted_at IS NULL
      ORDER BY d.issued_on DESC NULLS LAST, d.number DESC`,
    [q.ctx.subAccountId, kind]
  );

  let countedCents = 0;
  let notCountedCents = 0;
  const mapped = rows.map((r) => {
    const totalCents = Number(r.total_cents);
    const counts = documentCounts(kind, r.status);
    if (counts) countedCents += totalCents;
    else notCountedCents += totalCents;
    return {
      id: r.id,
      number: r.number,
      status: r.status,
      party: r.party,
      issuedOn: r.issued_on,
      sentAt: r.sent_at ? r.sent_at.toISOString() : null,
      projectId: r.project_id,
      projectTitle: r.project_title,
      lineCount: Number(r.line_count),
      totalCents,
      notes: r.notes,
      partyEmail: r.party_email,
      counts,
    };
  });

  return { rows: mapped, countedCents, notCountedCents };
}

/**
 * The next number to offer, following whatever the workspace already uses.
 *
 * Quotations and orders are numbered by hand on the project screen, and a
 * number typed twice is refused by a unique index — correctly, but only after
 * somebody has filled in a whole document. Suggesting the next one removes the
 * commonest way to waste that work, and it is only a suggestion: the field
 * stays editable, because plenty of businesses carry a number from elsewhere.
 *
 * Reads the workspace's OWN highest, rather than counting rows: deleting a
 * document must not hand its number to the next one, and a workspace that
 * starts at 5000 should carry on from there. Only numbers shaped like
 * `PREFIX-digits` are considered, so a one-off "Q-2024-SPECIAL" is left out of
 * the arithmetic instead of breaking it.
 */
export async function nextDocumentNumber(
  q: TenantQuery,
  kind: DocumentKind,
  prefix: string
): Promise<string> {
  const row = await q.one<{ highest: string | null }>(
    `SELECT MAX(substring(number from '^' || $3 || '-([0-9]+)$')::bigint)::text AS highest
       FROM documents
      WHERE sub_account_id = $1 AND kind = $2
        AND number ~ ('^' || $3 || '-[0-9]+$')`,
    [q.ctx.subAccountId, kind, prefix]
  );
  /* 1001 rather than 1, so a first quotation does not look like a first
     quotation to the client receiving it. */
  const next = row?.highest ? Number(row.highest) + 1 : 1001;
  return `${prefix}-${next}`;
}

/** The prefix each kind is numbered with, and the words used about it. */
export const LEDGERS = {
  quote: {
    kind: "quote" as const,
    prefix: "Q",
    title: "Quotes",
    one: "quotation",
    /* What the counted total means for this kind. */
    countedLabel: "Accepted",
    notCountedLabel: "Not accepted yet",
    partyLabel: "Client",
  },
  purchase_order: {
    kind: "purchase_order" as const,
    prefix: "PO",
    title: "Purchase orders",
    one: "purchase order",
    countedLabel: "Committed",
    notCountedLabel: "Cancelled or declined",
    partyLabel: "Supplier",
  },
} as const;
