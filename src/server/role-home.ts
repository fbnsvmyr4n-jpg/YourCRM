import { documentLedger } from "./document-ledger";
import { emailConfigured } from "./email";
import { aiConfigured } from "./ai";
import { telephonyConfigured } from "./telephony";
import { emailKey } from "./repos/auth";
import { failingAutomations } from "./repos/automations";
import { unreadCount } from "./repos/inbox";
import { pendingCount, stuckWork } from "./repos/outbox";
import { getConnection } from "./repos/payments";
import { listUsers } from "./repos/users";
import type { SystemQuery, TenantQuery } from "./tenant";

/**
 * The home pages for the two roles that never had one.
 *
 * Finance and IT were sent to Settings on sign-in, because Home was a sales
 * dashboard — meetings, leads, deals — and every figure on it is customer work
 * their tiers correctly keep from them. So the first screen a bookkeeper saw
 * was their own profile, and the first screen IT saw was the same.
 *
 * Each home answers ONE question, and nothing that does not serve it is here:
 *
 *   Finance — "who owes us, and who do I chase today?"
 *   IT      — "is anything broken, and who changed what?"
 *
 * ── Built from the same functions as the screens they summarise ───────────
 *
 * The invoice figures come from `documentLedger`, the function behind the
 * Invoices screen, and the operational ones from the repos behind System
 * health. A home page that totalled things its own way would be a second
 * answer to a question this product already answers, and the day the two
 * disagreed nobody would know which to believe.
 */

// ─────────────────────────────── FINANCE ────────────────────────────────

export type ChaseRow = {
  id: string;
  number: string;
  party: string | null;
  /** Where a chase would go — the document's own address, else the contact's. */
  email: string | null;
  owedCents: number;
  dueOn: string;
  daysLate: number;
};

export type PaymentRow = {
  id: string;
  documentId: string;
  number: string;
  party: string | null;
  amountCents: number;
  paidAt: string;
  /** "Card", "Transfer", "Cash"… — how it came in, for matching to the bank. */
  method: string;
};

export type FinanceHome = {
  outstandingCents: number;
  outstandingCount: number;
  overdueCents: number;
  chase: ChaseRow[];
  receivedThisMonthCents: number;
  receivedLastMonthCents: number;
  recent: PaymentRow[];
  draftInvoices: { count: number; cents: number };
  draftCredits: number;
  /** Null when the reader may not open the inbox, so the row is not drawn. */
  unread: number | null;
};

/** Whole days between two calendar dates, both YYYY-MM-DD. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

const METHOD_LABEL: Record<string, string> = {
  transfer: "Transfer",
  cash: "Cash",
  "card machine": "Card machine",
  cheque: "Cheque",
  other: "Other",
};

export async function financeHome(
  q: TenantQuery,
  opts: { today: string; timeZone: string; mayReadMail: boolean }
): Promise<FinanceHome> {
  const invoices = await documentLedger(q, "invoice");
  const credits = await documentLedger(q, "credit_note");

  /* What is owed on an invoice the client HAS, net of payments and credits.
     `dueCents` is already `owedCents` — VAT in, credits out — so this is the
     same arithmetic the settlement rule uses, not a fresh one. */
  const owing = invoices.rows
    .filter((r) => r.status !== "draft" && r.status !== "cancelled")
    .map((r) => ({ r, owed: Math.max(0, r.dueCents - r.receivedCents) }))
    .filter((x) => x.owed > 0);

  /*
     OVERDUE: owed, and past the date it was due.

     An invoice with no due date is never overdue — it is owed, and it is on
     the Outstanding figure, but calling it late would be inventing a deadline
     nobody set. Oldest first, because the longest-ignored debt is the one
     least likely to be paid without somebody picking up the phone.
  */
  const chase: ChaseRow[] = owing
    .filter((x) => x.r.dueOn !== null && x.r.dueOn < opts.today)
    .map((x) => ({
      id: x.r.id,
      number: x.r.number,
      party: x.r.party,
      email: x.r.partyEmail,
      owedCents: x.owed,
      dueOn: x.r.dueOn!,
      daysLate: daysBetween(x.r.dueOn!, opts.today),
    }))
    .sort((a, b) => b.daysLate - a.daysLate || a.number.localeCompare(b.number));

  /*
     Received this month, and last month for scale.

     Months in the BUSINESS's zone, not the server's — the same rule the date
     on every other screen follows. At 01:00 on the 1st in Johannesburg the
     server is still in last month, and a payment that landed at midnight
     would be counted in the wrong one.
  */
  const months = await q.one<{ this_month: string; last_month: string }>(
    `SELECT
       COALESCE(SUM(p.amount_cents) FILTER (
         WHERE date_trunc('month', p.paid_at AT TIME ZONE $2) = date_trunc('month', now() AT TIME ZONE $2)
       ), 0)::bigint::text AS this_month,
       COALESCE(SUM(p.amount_cents) FILTER (
         WHERE date_trunc('month', p.paid_at AT TIME ZONE $2)
             = date_trunc('month', (now() AT TIME ZONE $2) - interval '1 month')
       ), 0)::bigint::text AS last_month
       FROM invoice_payments p
       JOIN documents d ON d.id = p.document_id AND d.sub_account_id = p.sub_account_id
      WHERE p.sub_account_id = $1 AND p.status = 'paid'
        AND d.kind = 'invoice' AND d.deleted_at IS NULL`,
    [q.ctx.subAccountId, opts.timeZone]
  );

  const recent = await q.rows<{
    id: string;
    document_id: string;
    number: string;
    party: string | null;
    amount_cents: string;
    paid_at: Date;
    provider: string;
    channel: string | null;
  }>(
    `SELECT p.id, p.document_id, d.number, d.party, p.amount_cents::text AS amount_cents,
            p.paid_at, p.provider, p.channel
       FROM invoice_payments p
       JOIN documents d ON d.id = p.document_id AND d.sub_account_id = p.sub_account_id
      WHERE p.sub_account_id = $1 AND p.status = 'paid'
        AND d.kind = 'invoice' AND d.deleted_at IS NULL
      ORDER BY p.paid_at DESC, p.id DESC
      LIMIT 5`,
    [q.ctx.subAccountId]
  );

  const drafts = invoices.rows.filter((r) => r.status === "draft");

  return {
    outstandingCents: invoices.notCountedCents,
    outstandingCount: owing.length,
    overdueCents: chase.reduce((sum, c) => sum + c.owedCents, 0),
    chase,
    receivedThisMonthCents: Number(months?.this_month ?? 0),
    receivedLastMonthCents: Number(months?.last_month ?? 0),
    recent: recent.map((p) => ({
      id: p.id,
      documentId: p.document_id,
      number: p.number,
      party: p.party,
      amountCents: Number(p.amount_cents),
      paidAt: p.paid_at.toISOString(),
      /* A card payment arrives through the provider and says so; a hand-entered
         one carries the method the bookkeeper chose. */
      method: p.provider === "paystack" ? "Card" : METHOD_LABEL[p.channel ?? ""] ?? "Recorded by hand",
    })),
    draftInvoices: {
      count: drafts.length,
      cents: drafts.reduce((sum, r) => sum + r.dueCents, 0),
    },
    draftCredits: credits.rows.filter((r) => r.status === "draft").length,
    unread: opts.mayReadMail ? await unreadCount(q) : null,
  };
}

// ────────────────────────────────── IT ──────────────────────────────────

export type ServiceState = {
  name: string;
  ok: boolean;
  /** One line: what it does when it works, or what cannot happen without it. */
  says: string;
};

export type AccountChange = {
  id: number;
  at: string;
  who: string;
  what: string;
};

export type ItHomeTenant = {
  failedDeliveries: number;
  waitingToSend: number;
  stoppedAutomations: number;
  services: ServiceState[];
  changes: AccountChange[];
};

export type ItHomeAgency = {
  team: { total: number; byRole: { role: string; count: number }[] };
  lockedOut: { name: string; until: string }[];
};

/**
 * Records that are about how the ACCOUNT is set up, not about customers.
 *
 * The audit log records every write, including "somebody changed a contact".
 * That is not IT's business and it is most of the log, so a home page showing
 * the latest rows unfiltered would be a stream of sales activity with the one
 * role change somebody needed to notice buried in it.
 */
const ACCOUNT_ENTITIES = [
  "team_member",
  "password",
  "profile",
  "settings",
  "payment_connection",
  "sub_account",
  "automation",
  "booking_link",
  "agency_billing",
] as const;

const VERB: Record<string, string> = {
  create: "added",
  update: "changed",
  delete: "removed",
  restore: "restored",
};

/* Said the way a person would, not as a table name. */
const THING: Record<(typeof ACCOUNT_ENTITIES)[number], string> = {
  team_member: "a team member",
  password: "their password",
  profile: "their profile",
  settings: "settings",
  payment_connection: "the card-payment connection",
  sub_account: "a workspace",
  automation: "an automation",
  booking_link: "the booking link",
  agency_billing: "the subscription",
};

export async function itHomeTenant(q: TenantQuery): Promise<ItHomeTenant> {
  /* Only what is still broken. A job somebody already discarded is a decision,
     not a fault, and System health keeps it on record for that reason. */
  const stuck = (await stuckWork(q)).filter((j) => !j.discardedAt);
  const automations = await failingAutomations(q);
  const payments = await getConnection(q);

  const services: ServiceState[] = [
    {
      name: "Email",
      ok: emailConfigured(),
      says: emailConfigured()
        ? "Quotations, invoices and invitations are emailed."
        : "Nothing can be emailed — quotations, invoices and invitations stay here.",
    },
    {
      name: "Card payments",
      ok: payments?.mode === "live",
      says: !payments
        ? "Not connected — clients cannot pay an invoice by card."
        : payments.mode === "live"
          ? `Connected, live (key ending ${payments.keyLast4}).`
          : "Connected in TEST mode — no real money can be taken.",
    },
    {
      name: "AI assistant",
      ok: aiConfigured(),
      says: aiConfigured()
        ? "Answers questions and drafts quotations for approval."
        : "Answers from the data only — it cannot draft a quotation.",
    },
    {
      name: "Phone calls",
      ok: telephonyConfigured(),
      says: telephonyConfigured()
        ? "The voice agent answers calls."
        : "Not connected — the voice agent cannot take calls.",
    },
  ];

  const changes = await q.rows<{
    id: string;
    at: Date;
    actor_name: string | null;
    action: string;
    entity: (typeof ACCOUNT_ENTITIES)[number];
    detail: string | null;
  }>(
    `SELECT id::text AS id, at, actor_name, action, entity, detail
       FROM audit_events
      WHERE sub_account_id = $1 AND entity = ANY($2::text[])
      ORDER BY at DESC, id DESC
      LIMIT 6`,
    [q.ctx.subAccountId, [...ACCOUNT_ENTITIES]]
  );

  return {
    failedDeliveries: stuck.length,
    waitingToSend: await pendingCount(q),
    stoppedAutomations: automations.count,
    services,
    changes: changes.map((c) => ({
      id: Number(c.id),
      at: c.at.toISOString(),
      who: c.actor_name ?? "The system",
      what: `${VERB[c.action] ?? c.action} ${THING[c.entity] ?? c.entity.replace(/_/g, " ")}${
        c.detail ? ` — ${c.detail}` : ""
      }`,
    })),
  };
}

/**
 * The agency-wide half: people, and who cannot get in.
 *
 * A SYSTEM query, because users and sign-in attempts are not tenant tables —
 * the same split the Team card in Settings follows. Scoped by agency so one
 * business never sees another's staff.
 */
export async function itHomeAgency(q: SystemQuery, agencyId: string): Promise<ItHomeAgency> {
  const users = await listUsers(q, agencyId);

  const counts = new Map<string, number>();
  for (const u of users) counts.set(u.role, (counts.get(u.role) ?? 0) + 1);
  const order = ["owner", "admin", "finance", "member", "viewer"];

  /*
     LOCKED OUT RIGHT NOW.

     "I can't get in" is the call IT gets most, and the honest answer is often
     "you tried five times; it clears itself at 14:32". Matched on the
     per-EMAIL key only: the per-IP key cannot be tied to a person, and naming
     a colleague because somebody else on their network guessed badly would
     be a false accusation.
  */
  const byKey = new Map(users.map((u) => [emailKey(u.email), u.name]));
  const locked =
    byKey.size === 0
      ? []
      : await q.rows<{ key: string; locked_until: Date }>(
          `SELECT key, locked_until FROM login_attempts
            WHERE key = ANY($1::text[]) AND locked_until > now()
            ORDER BY locked_until`,
          [[...byKey.keys()]]
        );

  return {
    team: {
      total: users.length,
      byRole: order.filter((r) => counts.has(r)).map((r) => ({ role: r, count: counts.get(r)! })),
    },
    lockedOut: locked.map((l) => ({ name: byKey.get(l.key) ?? "A colleague", until: l.locked_until.toISOString() })),
  };
}
