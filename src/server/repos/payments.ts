import { randomBytes } from "node:crypto";
import type { SystemQuery, TenantQuery } from "../tenant";
import { decryptSecret, encryptSecret } from "../secrets";
import { addDays } from "../retainer-rules";
import { checkKeyShape, verifySecretKey, type Verified } from "../paystack";
import { logActivity } from "./activity";

/**
 * Taking payment for invoices: the workspace's Paystack connection, the public
 * pay link on each invoice, and the money Paystack confirms.
 *
 * Every tenant statement filters `sub_account_id` itself; row-level security
 * enforces the same underneath. The one read without a tenant is the pay-link
 * lookup, which runs under `withPublicLookup` and can see only the invoice
 * whose token the visitor already holds.
 */

export type PaymentConnection = { provider: "paystack"; mode: "test" | "live"; keyLast4: string; connectedAt: string };

export async function getConnection(q: TenantQuery): Promise<PaymentConnection | null> {
  const row = await q.one<{ mode: "test" | "live"; key_last4: string; connected_at: Date }>(
    `SELECT mode, key_last4, connected_at FROM payment_connections WHERE sub_account_id = $1`,
    [q.ctx.subAccountId]
  );
  return row ? { provider: "paystack", mode: row.mode, keyLast4: row.key_last4, connectedAt: row.connected_at.toISOString() } : null;
}

/**
 * The secret key, for a server-side call to Paystack and nothing else.
 * Null when there is no connection or it can no longer be read.
 */
export async function paystackSecret(q: TenantQuery): Promise<string | null> {
  const row = await q.one<{ secret_encrypted: string }>(
    `SELECT secret_encrypted FROM payment_connections WHERE sub_account_id = $1`,
    [q.ctx.subAccountId]
  );
  return row ? decryptSecret(row.secret_encrypted) : null;
}

/** Connect, or replace the key. Paystack is asked whether it accepts the key first. */
export async function connectPaystack(
  q: TenantQuery,
  rawKey: string,
  f: typeof fetch = fetch
): Promise<{ connection: PaymentConnection } | { error: string }> {
  const key = rawKey.trim();
  const shape = checkKeyShape(key);
  if (!shape.ok) return { error: shape.error };

  const accepted = await verifySecretKey(key, f);
  if (!accepted.ok) return { error: accepted.error };

  await q.rows(
    `INSERT INTO payment_connections (sub_account_id, provider, secret_encrypted, mode, key_last4, connected_by_user_id)
     VALUES ($1, 'paystack', $2, $3, $4, $5)
     ON CONFLICT (sub_account_id) DO UPDATE
       SET secret_encrypted = EXCLUDED.secret_encrypted, mode = EXCLUDED.mode, key_last4 = EXCLUDED.key_last4,
           connected_by_user_id = EXCLUDED.connected_by_user_id, connected_at = now()`,
    [q.ctx.subAccountId, encryptSecret(key), shape.mode, key.slice(-4), q.ctx.userId || null]
  );
  const connection = await getConnection(q);
  return { connection: connection! };
}

export async function disconnectPaystack(q: TenantQuery): Promise<boolean> {
  const rows = await q.rows<{ sub_account_id: string }>(
    `DELETE FROM payment_connections WHERE sub_account_id = $1 RETURNING sub_account_id`,
    [q.ctx.subAccountId]
  );
  return rows.length > 0;
}

/**
 * The invoice's pay link token, made the first time it is asked for.
 *
 * Only for an invoice that can still be paid. A draft may have one — the email
 * carrying it is written before the invoice is marked sent — but the pay page
 * refuses an invoice that has not been issued. 24 random bytes — the link is
 * the whole of the protection, so it is not a number anybody could count to.
 */
export async function ensurePayToken(q: TenantQuery, documentId: string): Promise<string | null> {
  const row = await q.one<{ pay_token: string | null }>(
    `UPDATE documents
        SET pay_token = COALESCE(pay_token, $3)
      WHERE sub_account_id = $1 AND id = $2 AND kind = 'invoice' AND deleted_at IS NULL
        AND status NOT IN ('paid', 'cancelled')
      RETURNING pay_token`,
    [q.ctx.subAccountId, documentId, randomBytes(24).toString("base64url")]
  );
  return row?.pay_token ?? null;
}

export type PayLink = { documentId: string; subAccountId: string; agencyId: string; workspaceName: string };

/** Which invoice a pay token is for. Run under `withPublicLookup("pay_token", token)`. */
export async function resolvePayToken(sys: SystemQuery, token: string): Promise<PayLink | null> {
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) return null;
  const row = await sys.one<{ id: string; sub_account_id: string; agency_id: string; name: string }>(
    `SELECT d.id, d.sub_account_id, s.agency_id, s.name
       FROM documents d
       JOIN sub_accounts s ON s.id = d.sub_account_id AND s.deleted_at IS NULL
      WHERE d.pay_token = $1 AND d.kind = 'invoice' AND d.deleted_at IS NULL`,
    [token]
  );
  return row ? { documentId: row.id, subAccountId: row.sub_account_id, agencyId: row.agency_id, workspaceName: row.name } : null;
}

/** What has been received against an invoice, in cents. */
export async function paidCents(q: TenantQuery, documentId: string): Promise<number> {
  const row = await q.one<{ n: string }>(
    `SELECT COALESCE(sum(amount_cents), 0)::text AS n FROM invoice_payments
      WHERE sub_account_id = $1 AND document_id = $2 AND status = 'paid'`,
    [q.ctx.subAccountId, documentId]
  );
  return Number(row?.n ?? 0);
}

/** The reference for one payment attempt: which invoice, and a random part so each attempt is new. */
export function paymentReference(documentId: string): string {
  return `yc_${documentId.replace(/[^A-Za-z0-9-]/g, "-")}_${randomBytes(6).toString("hex")}`;
}

/** The invoice a reference was made for — only a shape check; the database decides whether it exists. */
export function documentIdFromReference(reference: string): string | null {
  const m = /^yc_([A-Za-z0-9-]+)_[0-9a-f]{12}$/.exec(reference);
  return m ? m[1] : null;
}

export type Recorded =
  | { outcome: "paid"; number: string }
  | { outcome: "part_paid"; number: string; paidCents: number; totalCents: number }
  | { outcome: "already_recorded" }
  | { outcome: "ignored"; reason: string };

/**
 * Record money Paystack has CONFIRMED.
 *
 * `verified` must come from Paystack's own verify endpoint, never from a
 * redirect or a webhook body alone. The reference, the invoice it names, the
 * workspace and the currency all have to agree before anything is written, and
 * the same reference can only ever be recorded once — a return from checkout
 * and the webhook for it arriving together make one payment.
 *
 * The invoice is marked paid only when what has arrived covers it. A payment
 * that falls short is still recorded — the money is real — and said as such.
 */
export async function recordPaystackPayment(
  q: TenantQuery,
  verified: Verified,
  currency: string
): Promise<Recorded> {
  if (verified.status !== "success") return { outcome: "ignored", reason: `Paystack status is ${verified.status}` };
  const documentId = documentIdFromReference(verified.reference);
  if (!documentId) return { outcome: "ignored", reason: "the reference is not one of ours" };
  if (verified.currency !== currency) return { outcome: "ignored", reason: "paid in a different currency" };
  if (!Number.isSafeInteger(verified.amountCents) || verified.amountCents <= 0) {
    return { outcome: "ignored", reason: "no amount" };
  }

  const invoice = await q.one<{ id: string; number: string; deal_id: string; status: string; total: string }>(
    `SELECT d.id, d.number, d.deal_id, d.status,
            COALESCE((SELECT sum(ROUND(l.quantity * l.unit_cents)) FROM document_lines l
                       WHERE l.sub_account_id = d.sub_account_id AND l.document_id = d.id), 0)::bigint::text AS total
       FROM documents d
      WHERE d.sub_account_id = $1 AND d.id = $2 AND d.kind = 'invoice' AND d.deleted_at IS NULL
      FOR UPDATE OF d`,
    [q.ctx.subAccountId, documentId]
  );
  if (!invoice) return { outcome: "ignored", reason: "no such invoice in this workspace" };

  const inserted = await q.rows<{ id: string }>(
    `INSERT INTO invoice_payments (id, sub_account_id, document_id, provider, reference, amount_cents, currency, channel, paid_at)
     VALUES ($1, $2, $3, 'paystack', $4, $5, $6, $7, COALESCE($8::timestamptz, now()))
     ON CONFLICT (provider, reference) DO NOTHING
     RETURNING id`,
    [
      `pay_${randomBytes(12).toString("hex")}`,
      q.ctx.subAccountId,
      invoice.id,
      verified.reference,
      verified.amountCents,
      verified.currency,
      verified.channel,
      verified.paidAt,
    ]
  );
  if (inserted.length === 0) return { outcome: "already_recorded" };

  const received = await paidCents(q, invoice.id);
  const total = Number(invoice.total);
  const covered = received >= total;
  if (covered) {
    await q.rows(
      `UPDATE documents SET status = 'paid', updated_at = now() WHERE sub_account_id = $1 AND id = $2`,
      [q.ctx.subAccountId, invoice.id]
    );
  }
  await logActivity(q, {
    entityType: "deal",
    entityId: invoice.deal_id,
    kind: "updated",
    title: covered ? `${invoice.number} paid` : `Part payment on ${invoice.number}`,
    detail: `Received through Paystack (${verified.channel ?? "online"})`,
    amountCents: verified.amountCents,
    actorUserId: null,
  });
  return covered
    ? { outcome: "paid", number: invoice.number }
    : { outcome: "part_paid", number: invoice.number, paidCents: received, totalCents: total };
}

/** Who a task about a project goes to: its owner, when they can still see customer records. */
async function projectOwner(q: TenantQuery, dealId: string): Promise<string | null> {
  const row = await q.one<{ owner_user_id: string | null }>(
    `SELECT d.owner_user_id FROM deals d
       JOIN users u ON u.id = d.owner_user_id AND u.deleted_at IS NULL AND u.role IN ('owner', 'member')
      WHERE d.sub_account_id = $1 AND d.id = $2`,
    [q.ctx.subAccountId, dealId]
  );
  return row?.owner_user_id ?? null;
}

async function raiseTaskOnce(
  q: TenantQuery,
  sourceKey: string,
  task: { title: string; notes: string; dueOn: string; dealId: string; contactId: string | null }
): Promise<boolean> {
  const rows = await q.rows<{ id: string }>(
    `INSERT INTO todos (id, sub_account_id, title, notes, due_on, assignee_user_id, contact_id, deal_id, source_key)
     VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9)
     ON CONFLICT (sub_account_id, source_key) WHERE source_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      `td_${randomBytes(16).toString("hex")}`,
      q.ctx.subAccountId,
      task.title,
      task.notes,
      task.dueOn,
      await projectOwner(q, task.dealId),
      task.contactId,
      task.dealId,
      sourceKey,
    ]
  );
  return rows.length > 0;
}

/**
 * A chargeback: the customer's bank has taken the money back or is asking to.
 * Paystack's `charge.dispute.create`. Marks the payment and raises a task once.
 */
export async function recordDispute(q: TenantQuery, reference: string, today: string): Promise<boolean> {
  const payment = await q.one<{ document_id: string; number: string; deal_id: string; party_contact_id: string | null }>(
    `UPDATE invoice_payments p SET status = 'disputed'
       FROM documents d
      WHERE p.sub_account_id = $1 AND p.provider = 'paystack' AND p.reference = $2
        AND d.id = p.document_id AND d.sub_account_id = p.sub_account_id
      RETURNING p.document_id, d.number, d.deal_id, d.party_contact_id`,
    [q.ctx.subAccountId, reference]
  );
  if (!payment) return false;
  await q.rows(
    `UPDATE documents SET status = 'sent', updated_at = now()
      WHERE sub_account_id = $1 AND id = $2 AND status = 'paid'`,
    [q.ctx.subAccountId, payment.document_id]
  );
  return raiseTaskOnce(q, `dispute:${reference}`, {
    title: `Payment disputed on ${payment.number}`,
    notes: "The client's bank has opened a chargeback. Respond in your Paystack dashboard before the deadline it gives.",
    dueOn: today,
    dealId: payment.deal_id,
    contactId: payment.party_contact_id,
  });
}

/** How far back an overdue invoice still earns a reminder. Older ones are a conversation, not a task. */
export const OVERDUE_LOOKBACK_DAYS = 60;

/**
 * A task to chase each invoice that is past due and unpaid — once per invoice.
 *
 * This is what "a failed payment creates a task" can honestly mean: Paystack
 * sends no event when a customer's card is declined (they simply try again on
 * its checkout), so the fact worth acting on is money that has not arrived by
 * the date it was due.
 */
export async function chaseOverdueInvoices(q: TenantQuery, today: string): Promise<number> {
  const overdue = await q.rows<{ id: string; number: string; deal_id: string; party_contact_id: string | null; due_on: string }>(
    `SELECT d.id, d.number, d.deal_id, d.party_contact_id, d.due_on::text AS due_on
       FROM documents d
      WHERE d.sub_account_id = $1 AND d.kind = 'invoice' AND d.deleted_at IS NULL
        AND d.status = 'sent' AND d.due_on < $2::date AND d.due_on >= $3::date
        AND NOT EXISTS (SELECT 1 FROM todos t WHERE t.sub_account_id = d.sub_account_id
                         AND t.source_key = 'invoice-overdue:' || d.id)
      ORDER BY d.due_on, d.id
      LIMIT 50`,
    [q.ctx.subAccountId, today, addDays(today, -OVERDUE_LOOKBACK_DAYS)]
  );
  let raised = 0;
  for (const inv of overdue) {
    const made = await raiseTaskOnce(q, `invoice-overdue:${inv.id}`, {
      title: `Chase ${inv.number} — payment overdue`,
      notes: `Due ${inv.due_on} and not paid yet.`,
      dueOn: today,
      dealId: inv.deal_id,
      contactId: inv.party_contact_id,
    });
    if (made) raised += 1;
  }
  return raised;
}
