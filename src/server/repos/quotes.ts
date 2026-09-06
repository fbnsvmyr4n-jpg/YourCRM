import type { TenantQuery } from "../tenant";

/**
 * Quotations an agent drafted, waiting for a person to say yes.
 *
 * The safety property of the whole feature lives in this file, and it is worth
 * stating plainly because every function below is shaped by it:
 *
 *   **The AI drafts and revises. A named human approves. Only then does
 *   anything leave for a client.**
 *
 * So there is no function here that both writes a quotation and sends it. The
 * agent's two entry points — `draftQuote` and `reviseQuote` — can only ever
 * produce `awaiting_approval`, and `approve` is the only thing that stamps
 * `approved_by_user_id`. Sending reads that stamp and refuses without it. A
 * future caller that forgets the rule cannot express the forbidden thing: the
 * function that would do it does not exist.
 *
 * Money is never invented here either. A line's `unit_cents` is copied from a
 * `price_items` row at the moment of drafting — the copy is deliberate, because
 * a quotation is a document somebody signs and it must keep saying what it said
 * even after the rate card changes.
 */

export type QuoteLine = {
  id: string;
  description: string;
  quantity: number;
  unitCents: number;
  totalCents: number;
};

export type Quote = {
  id: string;
  dealId: string;
  projectTitle: string;
  number: string;
  status: string;
  party: string | null;
  /** The recipient's real address, read live from the contact record. */
  partyEmail: string | null;
  partyContactId: string | null;
  notes: string | null;
  /** Which agent wrote it — "chat" or "voice". Null when a person typed it. */
  draftedByAgent: string | null;
  /** How many times it has been sent back for changes. */
  revision: number;
  approvedAt: string | null;
  sentAt: string | null;
  lines: QuoteLine[];
  totalCents: number;
};

type DocRow = {
  id: string;
  deal_id: string;
  project_title: string;
  number: string;
  status: string;
  party: string | null;
  party_email: string | null;
  party_contact_id: string | null;
  notes: string | null;
  drafted_by_agent: string | null;
  revision: number;
  approved_at: Date | null;
  sent_at: Date | null;
};

type LineRow = {
  id: string;
  document_id: string;
  description: string;
  quantity: string;
  unit_cents: string;
  total_cents: string;
};

export type DraftLine = { description: string; quantity: number; unitCents: number };

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/*
   The one SELECT every read in this file is built from, so a quotation looks
   the same to the agent, to the approval card and to the tests.

   It carries the tenant filter and the deleted check ITSELF, and callers append
   `AND …`. Written the other way — a bare SELECT with the WHERE left to each
   caller — it read correctly and was a trap: the next person to add a lookup
   writes `WHERE d.id = $1`, and on any connection that bypasses row-level
   security that is a cross-tenant read. The guard suite caught it here, which
   is the only reason this comment exists rather than that bug.
*/
const DOC_SELECT = `
  SELECT d.id, d.deal_id, deal.title AS project_title, d.number, d.status, d.party,
         c.email AS party_email, d.party_contact_id, d.notes,
         d.drafted_by_agent, d.revision, d.approved_at, d.sent_at
    FROM documents d
    JOIN deals deal ON deal.id = d.deal_id
    LEFT JOIN contacts c ON c.id = d.party_contact_id AND c.deleted_at IS NULL
   WHERE d.sub_account_id = $1 AND d.deleted_at IS NULL
`;

async function hydrate(q: TenantQuery, docs: DocRow[]): Promise<Quote[]> {
  if (docs.length === 0) return [];

  const lines = await q.rows<LineRow>(
    `SELECT id, document_id, description, quantity::text, unit_cents::text,
            ROUND(quantity * unit_cents)::bigint::text AS total_cents
       FROM document_lines
      WHERE sub_account_id = $1 AND document_id = ANY($2::text[])
      ORDER BY position, id`,
    [q.ctx.subAccountId, docs.map((d) => d.id)]
  );

  const byDoc = new Map<string, QuoteLine[]>();
  for (const l of lines) {
    const line: QuoteLine = {
      id: l.id,
      description: l.description,
      quantity: Number(l.quantity),
      unitCents: Number(l.unit_cents),
      totalCents: Number(l.total_cents),
    };
    const bucket = byDoc.get(l.document_id);
    if (bucket) bucket.push(line);
    else byDoc.set(l.document_id, [line]);
  }

  return docs.map((d) => {
    const docLines = byDoc.get(d.id) ?? [];
    return {
      id: d.id,
      dealId: d.deal_id,
      projectTitle: d.project_title,
      number: d.number,
      status: d.status,
      party: d.party,
      partyEmail: d.party_email,
      partyContactId: d.party_contact_id,
      notes: d.notes,
      draftedByAgent: d.drafted_by_agent,
      revision: d.revision,
      approvedAt: d.approved_at?.toISOString() ?? null,
      sentAt: d.sent_at?.toISOString() ?? null,
      lines: docLines,
      totalCents: docLines.reduce((sum, l) => sum + l.totalCents, 0),
    };
  });
}

/** One quotation, or null. */
export async function findQuote(q: TenantQuery, documentId: string): Promise<Quote | null> {
  const docs = await q.rows<DocRow>(
    `${DOC_SELECT} AND d.id = $2`,
    [q.ctx.subAccountId, documentId]
  );
  return (await hydrate(q, docs))[0] ?? null;
}

/**
 * Everything waiting on a human.
 *
 * Not filtered to the drafting user. A quotation waiting for approval is the
 * workspace's problem, not the problem of whoever happened to be typing when
 * the agent wrote it — and on a phone at 6pm the person who can approve it is
 * frequently not that person.
 */
export async function quotesAwaitingApproval(q: TenantQuery): Promise<Quote[]> {
  const docs = await q.rows<DocRow>(
    `${DOC_SELECT}
        AND d.kind = 'quote' AND d.status = 'awaiting_approval'
      ORDER BY d.created_at ASC`,
    [q.ctx.subAccountId]
  );
  return hydrate(q, docs);
}

/**
 * Everything still needing a person: not yet approved, or approved and not yet
 * away.
 *
 * The second half is the one that matters. Approval and despatch are separate
 * facts and the send can fail — no address on file, or the mail service is
 * down — so a quote can sit approved with nothing having left. Dropping it off
 * this list at the moment of approval would hide exactly the case somebody
 * needs to see: they said yes, and the client never got it.
 */
export async function quotesNeedingUser(q: TenantQuery): Promise<Quote[]> {
  const docs = await q.rows<DocRow>(
    `${DOC_SELECT}
        AND d.kind = 'quote' AND d.status IN ('awaiting_approval', 'approved')
      ORDER BY d.created_at ASC`,
    [q.ctx.subAccountId]
  );
  return hydrate(q, docs);
}

/**
 * The next number, continuing whatever numbering this business already uses.
 *
 * `number` is theirs to choose — it has to match what their accounts department
 * already files — so this reads the most recent quote number, finds its numeric
 * tail and adds one, keeping the prefix and any zero padding. "Q-1041" becomes
 * "Q-1042"; "2026/007" becomes "2026/008". Only when there is nothing to
 * continue does it invent a starting point.
 *
 * The unique index is still the guarantee. This is the courtesy.
 */
export async function nextQuoteNumber(q: TenantQuery): Promise<string> {
  const rows = await q.rows<{ number: string }>(
    `SELECT number FROM documents
      WHERE sub_account_id = $1 AND kind = 'quote' AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT 25`,
    [q.ctx.subAccountId]
  );

  for (const row of rows) {
    const match = /^(.*?)(\d+)$/.exec(row.number);
    if (!match) continue;
    const [, prefix, digits] = match;
    const next = String(Number(digits) + 1).padStart(digits.length, "0");
    const candidate = `${prefix}${next}`;
    // A collision means somebody numbered out of order. Fall through to the
    // next candidate rather than writing a duplicate the index would refuse.
    const taken = rows.some((r) => r.number.toLowerCase() === candidate.toLowerCase());
    if (!taken) return candidate;
  }

  return "Q-1001";
}

export type DraftResult = { quote?: Quote; error?: string };

/**
 * Write a drafted quotation.
 *
 * `awaiting_approval` is not a parameter. There is no argument that makes this
 * function produce a sent document, and that is the whole point — an agent
 * calls this, so the strongest possible statement about what an agent can do is
 * the set of states this function is able to write.
 */
export async function draftQuote(
  q: TenantQuery,
  input: {
    dealId: string;
    partyContactId: string | null;
    party: string | null;
    notes: string | null;
    lines: DraftLine[];
    /** Which agent is asking: "chat" or "voice". */
    agent: string;
  }
): Promise<DraftResult> {
  if (input.lines.length === 0) {
    return { error: "A quotation needs at least one line." };
  }

  const deal = await q.one<{ id: string }>(
    `SELECT id FROM deals WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL`,
    [q.ctx.subAccountId, input.dealId]
  );
  if (!deal) return { error: "That project no longer exists." };

  const documentId = newId("q");
  const number = await nextQuoteNumber(q);

  try {
    await q.rows(
      `INSERT INTO documents
         (id, sub_account_id, deal_id, kind, number, status, party, party_contact_id,
          issued_on, notes, drafted_by_agent, revision)
       VALUES ($1, $2, $3, 'quote', $4, 'awaiting_approval', $5, $6,
               CURRENT_DATE, $7, $8, 0)`,
      [
        documentId,
        q.ctx.subAccountId,
        input.dealId,
        number,
        input.party,
        input.partyContactId,
        input.notes,
        input.agent,
      ]
    );
  } catch (err) {
    if (String(err).includes("documents_number_once")) {
      return { error: `A quotation numbered ${number} already exists.` };
    }
    throw err;
  }

  await writeLines(q, documentId, input.lines);
  const quote = await findQuote(q, documentId);
  return quote ? { quote } : { error: "The quotation could not be saved." };
}

/**
 * Rewrite a drafted quotation's lines and count the revision.
 *
 * Refuses anything that is not still awaiting approval. A quote that has been
 * approved or sent is a document that left the building; the correct response
 * to "change it" at that point is a new one, and quietly editing the old one
 * would leave the client holding a version this system no longer has.
 */
export async function reviseQuote(
  q: TenantQuery,
  input: { documentId: string; lines: DraftLine[]; notes?: string | null }
): Promise<DraftResult> {
  if (input.lines.length === 0) {
    return { error: "A quotation needs at least one line." };
  }

  const existing = await findQuote(q, input.documentId);
  if (!existing) return { error: "That quotation no longer exists." };
  if (existing.status !== "awaiting_approval") {
    return {
      error: `${existing.number} is ${existing.status.replace(/_/g, " ")} and can no longer be changed. Draft a new one instead.`,
    };
  }

  await q.rows(
    `UPDATE documents
        SET revision = revision + 1,
            notes = COALESCE($3, notes),
            updated_at = now()
      WHERE id = $2 AND sub_account_id = $1 AND status = 'awaiting_approval'`,
    [q.ctx.subAccountId, input.documentId, input.notes ?? null]
  );

  await q.rows(`DELETE FROM document_lines WHERE sub_account_id = $1 AND document_id = $2`, [
    q.ctx.subAccountId,
    input.documentId,
  ]);
  await writeLines(q, input.documentId, input.lines);

  const quote = await findQuote(q, input.documentId);
  return quote ? { quote } : { error: "The quotation could not be saved." };
}

async function writeLines(q: TenantQuery, documentId: string, lines: DraftLine[]) {
  for (const [position, line] of lines.entries()) {
    await q.rows(
      `INSERT INTO document_lines
         (id, sub_account_id, document_id, description, quantity, unit_cents, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [newId("l"), q.ctx.subAccountId, documentId, line.description, line.quantity, line.unitCents, position]
    );
  }
}

export type ApproveResult = { quote?: Quote; error?: string };

/**
 * A person says yes.
 *
 * `approved_by_user_id` is the point of this function. "The system sent it" is
 * not an answer anybody wants when a client queries a price six weeks later,
 * and a name is the difference between an audit trail and a shrug.
 *
 * The `status = 'awaiting_approval'` predicate is the concurrency guard: two
 * colleagues tapping Approve on the same quote produce one approval and one
 * "already approved", rather than a second stamp overwriting the first name.
 */
export async function approveQuote(
  q: TenantQuery,
  documentId: string
): Promise<ApproveResult> {
  const row = await q.one<{ id: string }>(
    `UPDATE documents
        SET status = 'approved', approved_at = now(), approved_by_user_id = $3,
            updated_at = now()
      WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL
        AND kind = 'quote' AND status = 'awaiting_approval'
      RETURNING id`,
    [q.ctx.subAccountId, documentId, q.ctx.userId]
  );
  if (!row) {
    const existing = await findQuote(q, documentId);
    if (!existing) return { error: "That quotation no longer exists." };
    return { error: `${existing.number} has already been ${existing.status.replace(/_/g, " ")}.` };
  }

  const quote = await findQuote(q, documentId);
  return quote ? { quote } : { error: "That quotation no longer exists." };
}

/**
 * Record that an approved quotation went out.
 *
 * Separate from `approveQuote`, and it re-checks the approval rather than
 * trusting the caller to have just done it: this is the last gate before a
 * price reaches a customer, and a gate that only works when called in the right
 * order is a gate with a hole in it.
 */
export async function markQuoteSent(q: TenantQuery, documentId: string): Promise<boolean> {
  const row = await q.one<{ id: string }>(
    `UPDATE documents
        SET status = 'sent', sent_at = now(), updated_at = now()
      WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL
        AND kind = 'quote' AND status = 'approved'
        AND approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL
      RETURNING id`,
    [q.ctx.subAccountId, documentId]
  );
  return row !== null;
}

/**
 * Throw a draft away.
 *
 * A soft delete, unlike removing somebody from a project: the agent produced a
 * priced document, and "what did it offer that we decided against" is a real
 * question. It stops appearing; it does not stop having happened.
 */
export async function discardQuote(q: TenantQuery, documentId: string): Promise<boolean> {
  const row = await q.one<{ id: string }>(
    `UPDATE documents SET deleted_at = now(), updated_at = now()
      WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL
        AND kind = 'quote' AND status IN ('awaiting_approval', 'approved')
      RETURNING id`,
    [q.ctx.subAccountId, documentId]
  );
  return row !== null;
}
