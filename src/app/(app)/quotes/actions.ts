"use server";

import { logWrite } from "@/server/log";
import { deliverQuote } from "@/server/quote-delivery";
import { findQuote } from "@/server/repos/quotes";
import { revalidateApp } from "@/server/revalidate";
import { requireTenant, withCurrentTenant } from "@/server/tenant-session";
import { id as validId } from "@/server/validate";
import type { FormState } from "@/app/(app)/projects/actions";

/**
 * Sending a quotation somebody wrote themselves.
 *
 * The chat flow already sends one: an agent drafts, a named person approves,
 * and only then does it go. That rule is not negotiable and is not relaxed
 * here — but `approveQuote` only moves a quotation out of `awaiting_approval`,
 * which is the state an AGENT's draft lands in. One typed by hand on this page
 * is a `draft`, so it could never reach a client at all.
 *
 * So this is the same gate for the other door. The person pressing Send is the
 * author, and pressing it is their approval: it is stamped with their name and
 * the moment, exactly as the agent's route stamps whoever said yes, so a client
 * querying a price six weeks later gets a name rather than "the system".
 *
 * The approval and the queued send commit together — that pairing is the point,
 * and it is why this does not simply call two actions in turn. Delivery runs
 * outside the transaction, because it talks to a mail provider and must not
 * hold one open while it does.
 */
export async function sendMyQuoteAction(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  const ctx = await requireTenant();
  const documentId = validId(formData.get("documentId"));
  if (!documentId) return { error: "That quotation could not be identified." };

  const approval = await withCurrentTenant(async (q) => {
    const quote = await findQuote(q, documentId);
    if (!quote) return { error: "That quotation no longer exists." };
    if (quote.sentAt || quote.status === "sent") {
      return { error: `${quote.number} has already been sent.` };
    }
    /* Only from the states a quotation can be sent FROM. `accepted` and `paid`
       are things that happened after it went; `declined` and `cancelled` are a
       no. Sending any of those would be re-sending history. */
    if (!["draft", "awaiting_approval", "approved"].includes(quote.status)) {
      return { error: `${quote.number} is ${quote.status.replace(/_/g, " ")}, so there is nothing to send.` };
    }

    /* Already approved by somebody: left exactly as it is, including who
       approved it. Re-stamping would quietly reassign the decision to whoever
       pressed Send. */
    if (quote.status !== "approved") {
      const row = await q.one<{ id: string }>(
        `UPDATE documents
            SET status = 'approved', approved_at = now(), approved_by_user_id = $3,
                updated_at = now()
          WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL
            AND kind = 'quote' AND status IN ('draft', 'awaiting_approval')
          RETURNING id`,
        [q.ctx.subAccountId, documentId, q.ctx.userId]
      );
      if (!row) return { error: `${quote.number} could not be approved. Reload and try again.` };
      logWrite("approve", "quote", { id: documentId, actor: q.ctx.userId });
    }
    return { ok: "approved" };
  });

  if ("error" in approval && approval.error) return { error: approval.error };

  const message = await deliverQuote(ctx, documentId);
  revalidateApp();
  return { ok: message };
}

/**
 * The lines on one document, fetched when somebody opens it to edit.
 *
 * Not carried on every row of the list. A workspace with five hundred
 * quotations of ten lines each would render five thousand rows nobody asked
 * for, to support an action taken on one of them — and editing is rare next to
 * reading. So the list stays a list, and this is the cost of the edit itself.
 *
 * The tenant check is the FIRST statement, with the id validated inside it. A
 * server action is a public POST endpoint, and checking an id before
 * establishing who is asking makes that validation the only thing a stranger
 * meets — which is why `authorisation.test.ts` reads the first line of every
 * one of these and refuses anything else.
 */
export async function documentLinesAction(
  documentId: string
): Promise<{ lines: { description: string; quantity: number; unitCents: number }[] } | { error: string }> {
  return withCurrentTenant(async (q) => {
    const id = validId(documentId);
    if (!id) return { error: "That document could not be identified." };
    const rows = await q.rows<{ description: string; quantity: string; unit_cents: string }>(
      `SELECT l.description, l.quantity::text, l.unit_cents::text
         FROM document_lines l
         JOIN documents d ON d.id = l.document_id AND d.sub_account_id = l.sub_account_id
        WHERE l.sub_account_id = $1 AND l.document_id = $2 AND d.deleted_at IS NULL
        ORDER BY l.position, l.id`,
      [q.ctx.subAccountId, id]
    );
    return {
      lines: rows.map((r) => ({
        description: r.description,
        quantity: Number(r.quantity),
        unitCents: Number(r.unit_cents),
      })),
    };
  });
}
