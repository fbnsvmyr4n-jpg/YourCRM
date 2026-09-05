import type { TenantQuery } from "../tenant";
import type { Stage } from "./deals";

/**
 * One project, and everything hanging off it.
 *
 * The list page answers "what are we doing for this client". This answers the
 * next question, which is the one somebody actually opens a job to ask: who is
 * on it, what has been said, what have we quoted, what have we committed to
 * spend, and what happened when.
 *
 * A project is still a deal — that decision has not changed and this file does
 * not add a second entity. What it adds is the things a SALE never needed and a
 * JOB always did: more than one person, documents with money on them, and email
 * that belongs to the work rather than to a contact.
 *
 * Every read here is one statement per concern rather than one per row. A
 * project with a dozen people, forty emails and six documents would otherwise
 * be sixty round trips to draw one screen.
 */

/* ---------------- the project itself ---------------- */

export type ProjectHeader = {
  id: string;
  title: string;
  /** Where the work is. "Heineken Stellenbosch" is the site, not the title. */
  site: string | null;
  stage: Stage;
  valueCents: number;
  startsOn: string | null;
  dueOn: string | null;
  companyId: string | null;
  companyName: string | null;
  ownerName: string | null;
  createdAt: string;
};

type HeaderRow = {
  id: string;
  title: string;
  site: string | null;
  stage: Stage;
  value_cents: string;
  /** Text, not Date. See `day` below — this is the whole of that fix. */
  starts_on: string | null;
  due_on: string | null;
  company_id: string | null;
  company_name: string | null;
  owner_name: string | null;
  created_at: Date;
};

/**
 * A DATE is a calendar day, and must never become a `Date`.
 *
 * This was `d.toISOString().slice(0, 10)` and it was wrong by a day. The driver
 * parses a DATE column into local midnight; `toISOString` then converts to UTC,
 * so on any machine east of Greenwich a 1 September start renders as 31 August.
 * Caught by a test written to expect the calendar day — it would not have shown
 * up on a server running in UTC, which is exactly how this kind of thing
 * reaches a customer in Johannesburg and nobody else.
 *
 * The columns are cast to text in SQL now, so Postgres hands over "2026-09-01"
 * and no timezone is ever applied to a thing that has no time in it. This
 * function only tidies up the empty case.
 */
const day = (value: string | null): string | null => value ?? null;

export async function projectHeader(q: TenantQuery, id: string): Promise<ProjectHeader | null> {
  const row = await q.one<HeaderRow>(
    `SELECT d.id, d.title, d.site, d.stage, d.value_cents,
            d.starts_on::text AS starts_on, d.due_on::text AS due_on,
            d.company_id, co.name AS company_name, u.name AS owner_name, d.created_at
       FROM deals d
       LEFT JOIN companies co ON co.id = d.company_id AND co.deleted_at IS NULL
       LEFT JOIN users u ON u.id = d.owner_user_id AND u.deleted_at IS NULL
      WHERE d.id = $2 AND d.sub_account_id = $1 AND d.deleted_at IS NULL`,
    [q.ctx.subAccountId, id]
  );
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    site: row.site,
    stage: row.stage,
    valueCents: Number(row.value_cents),
    startsOn: day(row.starts_on),
    dueOn: day(row.due_on),
    companyId: row.company_id,
    companyName: row.company_name,
    ownerName: row.owner_name,
    createdAt: row.created_at.toISOString(),
  };
}

/* ---------------- who is on the job ---------------- */

export type ProjectPerson = {
  id: string;
  /** "us" is a colleague, "client" is somebody at the customer. */
  side: "us" | "client";
  personId: string;
  name: string;
  email: string | null;
  phone: string | null;
  /** Their job title, or their role on this particular project. */
  jobTitle: string | null;
  roleOnJob: string | null;
};

type PersonRow = {
  id: string;
  user_id: string | null;
  contact_id: string | null;
  role_on_job: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  job_title: string | null;
};

/**
 * Both sides of the team, in one statement.
 *
 * A UNION rather than two queries and a merge in TypeScript: "everyone on this
 * job" is one question, and asking it twice is how the two halves end up sorted
 * differently, or one of them quietly dropped when somebody edits one branch.
 *
 * Deleted people are excluded by the join, not by a flag the caller has to
 * remember — somebody who has left the company stops appearing on the job
 * without anybody having to tidy up after them.
 */
export async function projectPeople(q: TenantQuery, dealId: string): Promise<ProjectPerson[]> {
  const rows = await q.rows<PersonRow>(
    `SELECT p.id, p.user_id, p.contact_id, p.role_on_job,
            u.name, u.email, u.phone, u.job_title
       FROM project_people p
       JOIN users u ON u.id = p.user_id AND u.deleted_at IS NULL
      WHERE p.sub_account_id = $1 AND p.deal_id = $2 AND p.user_id IS NOT NULL

      UNION ALL

     SELECT p.id, p.user_id, p.contact_id, p.role_on_job,
            NULLIF(TRIM(CONCAT(c.first_name, ' ', c.last_name)), '') AS name,
            c.email, c.phone, NULL AS job_title
       FROM project_people p
       JOIN contacts c
            ON c.id = p.contact_id
           AND c.sub_account_id = p.sub_account_id
           AND c.deleted_at IS NULL
      WHERE p.sub_account_id = $1 AND p.deal_id = $2 AND p.contact_id IS NOT NULL

      ORDER BY 5`,
    [q.ctx.subAccountId, dealId]
  );

  return rows.map((r) => ({
    id: r.id,
    side: r.user_id ? "us" : "client",
    personId: (r.user_id ?? r.contact_id)!,
    name: r.name ?? "Unnamed",
    email: r.email,
    phone: r.phone,
    jobTitle: r.job_title,
    roleOnJob: r.role_on_job,
  }));
}

/* ---------------- quotations and purchase orders ---------------- */

export type DocumentKind = "quote" | "purchase_order" | "invoice";
export type DocumentStatus =
  | "draft"
  | "sent"
  | "accepted"
  | "declined"
  | "paid"
  | "cancelled";

export type DocumentLine = {
  id: string;
  description: string;
  quantity: number;
  unitCents: number;
  /** Rounded to whole cents in the database, never multiplied in JavaScript. */
  totalCents: number;
};

export type ProjectDocument = {
  id: string;
  kind: DocumentKind;
  number: string;
  status: DocumentStatus;
  party: string | null;
  issuedOn: string | null;
  dueOn: string | null;
  notes: string | null;
  lines: DocumentLine[];
  totalCents: number;
};

type DocRow = {
  id: string;
  kind: DocumentKind;
  number: string;
  status: DocumentStatus;
  party: string | null;
  issued_on: string | null;
  due_on: string | null;
  notes: string | null;
  created_at: Date;
};

type LineRow = {
  id: string;
  document_id: string;
  description: string;
  quantity: string;
  unit_cents: string;
  total_cents: string;
};

/**
 * Documents with their lines, in two statements rather than one per document.
 *
 * The totals are computed by Postgres — `ROUND(quantity * unit_cents)` — not in
 * TypeScript. Quantity is NUMERIC, which is exact decimal; pulling it into a
 * JavaScript number to multiply it would reintroduce the floating point error
 * the column type exists to avoid, and it would do so on the one figure a
 * customer checks against their own accounts.
 */
export async function projectDocuments(
  q: TenantQuery,
  dealId: string
): Promise<ProjectDocument[]> {
  const docs = await q.rows<DocRow>(
    `SELECT id, kind, number, status, party,
            issued_on::text AS issued_on, due_on::text AS due_on,
            notes, created_at
       FROM documents
      WHERE sub_account_id = $1 AND deal_id = $2 AND deleted_at IS NULL
      ORDER BY issued_on DESC NULLS LAST, created_at DESC`,
    [q.ctx.subAccountId, dealId]
  );
  if (docs.length === 0) return [];

  const lines = await q.rows<LineRow>(
    `SELECT l.id, l.document_id, l.description, l.quantity::text, l.unit_cents::text,
            ROUND(l.quantity * l.unit_cents)::bigint::text AS total_cents
       FROM document_lines l
       JOIN documents d ON d.id = l.document_id AND d.deleted_at IS NULL
      WHERE l.sub_account_id = $1 AND d.deal_id = $2
      ORDER BY l.position, l.id`,
    [q.ctx.subAccountId, dealId]
  );

  const byDoc = new Map<string, DocumentLine[]>();
  for (const l of lines) {
    const line: DocumentLine = {
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
      kind: d.kind,
      number: d.number,
      status: d.status,
      party: d.party,
      issuedOn: day(d.issued_on),
      dueOn: day(d.due_on),
      notes: d.notes,
      lines: docLines,
      totalCents: docLines.reduce((sum, l) => sum + l.totalCents, 0),
    };
  });
}

/* ---------------- email threads ---------------- */

export type ProjectThread = {
  id: string;
  subject: string;
  messages: number;
  /** Everybody who appears in the thread, by name where one is known. */
  participants: string[];
  lastAt: string;
  lastPreview: string;
  unread: number;
};

type ThreadRow = {
  thread_id: string;
  subject: string;
  messages: string;
  participants: string[];
  last_at: Date;
  last_preview: string;
  unread: string;
};

/**
 * The conversations that belong to this job.
 *
 * Grouped in SQL rather than fetched flat and grouped afterwards: a busy
 * project is hundreds of messages, and the screen needs the threads, not the
 * mail.
 *
 * `subject` is taken from the EARLIEST message, not the latest. A thread is
 * named by what it was opened about — the most recent reply is usually
 * "Re: Re: Fwd:" of it, and naming the thread after that produces a list of
 * prefixes.
 */
export async function projectThreads(q: TenantQuery, dealId: string): Promise<ProjectThread[]> {
  const rows = await q.rows<ThreadRow>(
    `SELECT m.thread_id,
            (ARRAY_AGG(m.subject ORDER BY m.sent_at ASC))[1]                AS subject,
            count(*)::text                                                  AS messages,
            ARRAY_REMOVE(ARRAY_AGG(DISTINCT
              NULLIF(TRIM(CONCAT(c.first_name, ' ', c.last_name)), '')), NULL) AS participants,
            MAX(m.sent_at)                                                  AS last_at,
            (ARRAY_AGG(m.body ORDER BY m.sent_at DESC))[1]                  AS last_preview,
            count(*) FILTER (WHERE m.unread)::text                          AS unread
       FROM messages m
       LEFT JOIN contacts c
            ON c.id = m.contact_id
           AND c.sub_account_id = m.sub_account_id
           AND c.deleted_at IS NULL
      WHERE m.sub_account_id = $1 AND m.deal_id = $2 AND m.deleted_at IS NULL
      GROUP BY m.thread_id
      ORDER BY MAX(m.sent_at) DESC`,
    [q.ctx.subAccountId, dealId]
  );

  return rows.map((r) => ({
    id: r.thread_id,
    subject: r.subject || "(no subject)",
    messages: Number(r.messages),
    participants: r.participants ?? [],
    lastAt: r.last_at.toISOString(),
    lastPreview: r.last_preview.slice(0, 160),
    unread: Number(r.unread),
  }));
}

/* ---------------- one chronology ---------------- */

export type TimelineKind = "email" | "meeting" | "call" | "note" | "document";

export type ProjectEvent = {
  id: string;
  kind: TimelineKind;
  title: string;
  detail: string | null;
  at: string;
  amountCents: number | null;
};

type EventRow = {
  id: string;
  kind: TimelineKind;
  title: string;
  detail: string | null;
  at: Date;
  amount_cents: string | null;
};

/**
 * Everything that has happened on this job, in order.
 *
 * The reason the page is an overview rather than five lists. A UNION across the
 * five things that can happen — mail, meetings, calls, notes, documents —
 * ordered by when, so somebody picking the job up after a fortnight reads down
 * it instead of cross-referencing tabs by date.
 *
 * It is also, deliberately, the shape the assistant will need: every word
 * written about a project reachable in ONE query, scoped to that project. A
 * draft written from four separate reads is a draft that can miss the reply
 * that changed everything.
 */
export async function projectTimeline(
  q: TenantQuery,
  dealId: string,
  limit = 100
): Promise<ProjectEvent[]> {
  const rows = await q.rows<EventRow>(
    `SELECT m.id, 'email' AS kind,
            COALESCE(NULLIF(m.subject, ''), '(no subject)') AS title,
            LEFT(m.body, 200) AS detail, m.sent_at AS at, NULL::bigint AS amount_cents
       FROM messages m
      WHERE m.sub_account_id = $1 AND m.deal_id = $2 AND m.deleted_at IS NULL

      UNION ALL
     SELECT mt.id, 'meeting', mt.topic, mt.notes, mt.scheduled_at, NULL::bigint
       FROM meetings mt
      WHERE mt.sub_account_id = $1 AND mt.deal_id = $2 AND mt.deleted_at IS NULL

      UNION ALL
     -- created_deal_id, not deal_id: a call is what CREATED the deal, and the
     -- column says so. And summary, not transcript -- the transcript is JSONB,
     -- a turn-by-turn array that would render as raw JSON in a timeline row.
     -- Both were assumed before the table was read, and both were wrong.
     SELECT cl.id, 'call',
            COALESCE(NULLIF(cl.caller_name, ''), 'Call'),
            cl.summary, cl.received_at, NULL::bigint
       FROM calls cl
      WHERE cl.sub_account_id = $1 AND cl.created_deal_id = $2 AND cl.deleted_at IS NULL

      UNION ALL
     SELECT a.id, 'note', a.title, a.detail, a.at, a.amount_cents
       FROM activities a
      WHERE a.sub_account_id = $1 AND a.entity_type = 'deal' AND a.entity_id = $2

      UNION ALL
     SELECT d.id, 'document',
            CASE d.kind
              WHEN 'quote' THEN 'Quotation ' || d.number
              WHEN 'purchase_order' THEN 'Purchase order ' || d.number
              ELSE 'Invoice ' || d.number
            END,
            d.party,
            COALESCE(d.issued_on::timestamptz, d.created_at),
            (SELECT ROUND(SUM(l.quantity * l.unit_cents))::bigint
               FROM document_lines l WHERE l.document_id = d.id)
       FROM documents d
      WHERE d.sub_account_id = $1 AND d.deal_id = $2 AND d.deleted_at IS NULL

      ORDER BY at DESC
      LIMIT $3`,
    [q.ctx.subAccountId, dealId, limit]
  );

  return rows.map((r) => ({
    id: `${r.kind}-${r.id}`,
    kind: r.kind,
    title: r.title,
    detail: r.detail,
    at: r.at.toISOString(),
    amountCents: r.amount_cents === null ? null : Number(r.amount_cents),
  }));
}
