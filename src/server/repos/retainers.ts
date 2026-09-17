import type { TenantQuery } from "../tenant";
import { nextInvoiceNumber } from "../invoice-from-quote";
import {
  addDays,
  duePeriods,
  firstPeriodFrom,
  periodEnd,
  periodLabel,
  periodStart,
  type Retainer,
  type RetainerEvery,
  type RetainerStatus,
} from "../retainer-rules";

/**
 * Retainers as rows, and the invoices they raise.
 *
 * Every statement filters `sub_account_id` itself; row-level security enforces
 * the same underneath, and a trigger refuses a project from another workspace.
 */

type Row = {
  id: string;
  deal_id: string;
  description: string;
  amount_cents: string;
  every: RetainerEvery;
  starts_on: string;
  ends_on: string | null;
  due_days: number;
  status: RetainerStatus;
  periods_billed: number;
  next_invoice_on: string;
  created_at: Date;
};

const COLUMNS = `id, deal_id, description, amount_cents::text AS amount_cents, every,
                 starts_on::text AS starts_on, ends_on::text AS ends_on, due_days, status,
                 periods_billed, next_invoice_on::text AS next_invoice_on, created_at`;

/* The same columns, named through the `r` alias for the join below. */
const R_COLUMNS = `r.id, r.deal_id, r.description, r.amount_cents::text AS amount_cents, r.every,
                   r.starts_on::text AS starts_on, r.ends_on::text AS ends_on, r.due_days, r.status,
                   r.periods_billed, r.next_invoice_on::text AS next_invoice_on, r.created_at`;

const toRetainer = (r: Row): Retainer => ({
  id: r.id,
  dealId: r.deal_id,
  description: r.description,
  amountCents: Number(r.amount_cents),
  every: r.every,
  startsOn: r.starts_on,
  endsOn: r.ends_on,
  dueDays: r.due_days,
  status: r.status,
  periodsBilled: r.periods_billed,
  nextInvoiceOn: r.next_invoice_on,
  createdAt: r.created_at.toISOString(),
});

export async function listRetainers(q: TenantQuery, dealId?: string): Promise<Retainer[]> {
  const rows = await q.rows<Row>(
    `SELECT ${COLUMNS} FROM retainers
      WHERE sub_account_id = $1 AND ($2::text IS NULL OR deal_id = $2)
      ORDER BY (status = 'cancelled'), created_at DESC, id`,
    [q.ctx.subAccountId, dealId ?? null]
  );
  return rows.map(toRetainer);
}

export type RetainerInput = {
  description: string;
  amountCents: number;
  every: RetainerEvery;
  startsOn: string;
  endsOn: string | null;
  dueDays: number;
};

export async function createRetainer(
  q: TenantQuery,
  dealId: string,
  input: RetainerInput
): Promise<{ retainer: Retainer } | { error: string }> {
  const deal = await q.one<{ id: string }>(
    `SELECT id FROM deals WHERE sub_account_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [q.ctx.subAccountId, dealId]
  );
  if (!deal) return { error: "That project no longer exists." };

  const row = await q.one<Row>(
    `INSERT INTO retainers
       (id, sub_account_id, deal_id, description, amount_cents, every, starts_on, ends_on, due_days,
        next_invoice_on, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING ${COLUMNS}`,
    [
      `rt_${crypto.randomUUID().replace(/-/g, "")}`,
      q.ctx.subAccountId,
      dealId,
      input.description,
      input.amountCents,
      input.every,
      input.startsOn,
      input.endsOn,
      input.dueDays,
      periodStart(input.startsOn, input.every, 0),
      q.ctx.userId || null,
    ]
  );
  if (!row) throw new Error("Retainer was not created.");
  return { retainer: toRetainer(row) };
}

/** What a retainer bills from now on. Invoices already raised keep their figures. */
export async function updateRetainer(
  q: TenantQuery,
  id: string,
  patch: Pick<RetainerInput, "description" | "amountCents" | "dueDays" | "endsOn">
): Promise<{ retainer: Retainer } | { error: string }> {
  try {
    const row = await q.attempt(() =>
      q.one<Row>(
        `UPDATE retainers SET description = $3, amount_cents = $4, due_days = $5, ends_on = $6
          WHERE sub_account_id = $1 AND id = $2 AND status <> 'cancelled'
          RETURNING ${COLUMNS}`,
        [q.ctx.subAccountId, id, patch.description, patch.amountCents, patch.dueDays, patch.endsOn]
      )
    );
    return row ? { retainer: toRetainer(row) } : { error: "That retainer has ended or no longer exists." };
  } catch (err) {
    if ((err as { code?: string }).code === "23514") return { error: "The end date is before the retainer starts." };
    throw err;
  }
}

/**
 * Pause, resume or cancel.
 *
 * Resuming does NOT bill the months it was paused for — that is what a pause
 * means. It picks up at the first period starting on or after today.
 * Cancelling is final; the invoices it already raised stay where they are.
 */
export async function setRetainerStatus(
  q: TenantQuery,
  id: string,
  to: RetainerStatus,
  today: string
): Promise<{ retainer: Retainer } | { error: string }> {
  const current = await q.one<Row>(
    `SELECT ${COLUMNS} FROM retainers WHERE sub_account_id = $1 AND id = $2 FOR UPDATE`,
    [q.ctx.subAccountId, id]
  );
  if (!current) return { error: "That retainer no longer exists." };
  const r = toRetainer(current);
  if (r.status === "cancelled") return { error: "That retainer has been cancelled." };
  if (r.status === to) return { retainer: r };

  let periodsBilled = r.periodsBilled;
  if (to === "active") periodsBilled = Math.max(r.periodsBilled, firstPeriodFrom(r.startsOn, r.every, today));

  const row = await q.one<Row>(
    `UPDATE retainers
        SET status = $3,
            periods_billed = $4,
            next_invoice_on = $5,
            cancelled_at = CASE WHEN $3 = 'cancelled' THEN now() ELSE NULL END
      WHERE sub_account_id = $1 AND id = $2
      RETURNING ${COLUMNS}`,
    [q.ctx.subAccountId, id, to, periodsBilled, periodStart(r.startsOn, r.every, periodsBilled)]
  );
  return { retainer: toRetainer(row!) };
}

/**
 * Raise the invoices that are due, as drafts, and move each retainer on.
 *
 * Safe to call on every page load: the due rows are locked with SKIP LOCKED,
 * so a second request arriving together finds nothing to do rather than
 * waiting, and the unique (retainer, period) index means the same period can
 * never become two invoices even if something else got there first.
 *
 * Drafts, never sent. Raising a bill and putting it in a client's inbox are two
 * decisions; the second stays with a person.
 */
export async function raiseDueRetainerInvoices(
  q: TenantQuery,
  today: string
): Promise<{ raised: number; numbers: string[] }> {
  const due = await q.rows<Row & { party: string | null; party_contact_id: string | null }>(
    `SELECT ${R_COLUMNS},
            NULLIF(btrim(concat(c.first_name, ' ', c.last_name)), '') AS party,
            d.contact_id AS party_contact_id
       FROM retainers r
       JOIN deals d ON d.id = r.deal_id AND d.sub_account_id = r.sub_account_id AND d.deleted_at IS NULL
       LEFT JOIN contacts c ON c.id = d.contact_id AND c.sub_account_id = r.sub_account_id AND c.deleted_at IS NULL
      WHERE r.sub_account_id = $1 AND r.status = 'active' AND r.next_invoice_on <= $2::date
        AND (r.ends_on IS NULL OR r.next_invoice_on <= r.ends_on)
      ORDER BY r.next_invoice_on, r.id
      FOR UPDATE OF r SKIP LOCKED`,
    [q.ctx.subAccountId, today]
  );

  const numbers: string[] = [];
  for (const row of due) {
    const r = toRetainer(row);
    const plan = duePeriods(r, today);

    for (const n of plan.periods) {
      const start = periodStart(r.startsOn, r.every, n);
      const number = await nextInvoiceNumber(q);
      const invoiceId = `inv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        await q.attempt(async () => {
          await q.rows(
            `INSERT INTO documents
               (id, sub_account_id, deal_id, kind, number, status, party, party_contact_id,
                issued_on, due_on, retainer_id, period_start)
             VALUES ($1, $2, $3, 'invoice', $4, 'draft', $5, $6, $7, $8, $9, $10)`,
            [
              invoiceId,
              q.ctx.subAccountId,
              r.dealId,
              number,
              row.party,
              row.party_contact_id,
              start,
              addDays(start, r.dueDays),
              r.id,
              start,
            ]
          );
          await q.rows(
            `INSERT INTO document_lines (id, sub_account_id, document_id, description, quantity, unit_cents, position)
             VALUES ($1, $2, $3, $4, 1, $5, 0)`,
            [
              `dl-${invoiceId}-0`,
              q.ctx.subAccountId,
              invoiceId,
              `${r.description} — ${periodLabel(start, periodEnd(r.startsOn, r.every, n))}`,
              r.amountCents,
            ]
          );
        });
        numbers.push(number);
      } catch (err) {
        /* Already billed — by a request that raced this one. Moving on is
           right; billing it again is not. ONLY that constraint: an invoice
           NUMBER taken by somebody raising one by hand at the same moment must
           fail the whole run, or this period would be skipped for ever while
           the retainer moved past it. */
        const e = err as { code?: string; constraint?: string };
        if (e.code !== "23505" || e.constraint !== "documents_retainer_period_once") throw err;
      }
    }

    await q.rows(
      `UPDATE retainers SET periods_billed = $3, next_invoice_on = $4 WHERE sub_account_id = $1 AND id = $2`,
      [q.ctx.subAccountId, r.id, plan.periodsBilled, plan.nextInvoiceOn]
    );
  }
  return { raised: numbers.length, numbers };
}

/** Invoices a retainer raised that nobody has sent yet, and which projects they are on. For the bell. */
export async function retainerDraftsWaiting(q: TenantQuery): Promise<{ count: number; dealIds: string[] }> {
  const rows = await q.rows<{ deal_id: string; n: string }>(
    `SELECT deal_id, count(*)::text AS n FROM documents
      WHERE sub_account_id = $1 AND kind = 'invoice' AND retainer_id IS NOT NULL
        AND status = 'draft' AND deleted_at IS NULL
      GROUP BY deal_id ORDER BY deal_id`,
    [q.ctx.subAccountId]
  );
  return { count: rows.reduce((s, r) => s + Number(r.n), 0), dealIds: rows.map((r) => r.deal_id) };
}
