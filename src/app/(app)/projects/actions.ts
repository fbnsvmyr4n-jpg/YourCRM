"use server";

import { revalidateApp } from "@/server/revalidate";
import { withCurrentTenant } from "@/server/tenant-session";
import { decimal, id as validId, multiline, pick, text } from "@/server/validate";

/**
 * Running a project: who is on it, what it is quoted at, when it is due.
 *
 * Every action here goes through `withCurrentTenant`, which is the
 * authorisation, the plan gate and the customer-data gate in one call. None of
 * them opts out — a project IS customer data, so IT and accounts are refused by
 * construction rather than by a check written into each one.
 */

export type FormState = { ok?: string; error?: string } | undefined;

const DOC_KINDS = ["quote", "purchase_order", "invoice"] as const;
/** A single line item's unit price ceiling, in whole currency units. */
const MAX_UNIT_PRICE = 100_000_000;
const DOC_STATUSES = ["draft", "sent", "accepted", "declined", "paid", "cancelled"] as const;

/** A `YYYY-MM-DD` from a date input, or null. Never parsed into a Date. */
function isoDate(value: unknown): string | null {
  const v = text(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The site and the dates.
 *
 * Separate from editing the deal on the pipeline board, because these are the
 * fields a project has and a sale does not. Everything else about the record —
 * its title, its value, its stage — is edited where it always was.
 */
export async function updateProjectAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return withCurrentTenant(async (q) => {
    const dealId = validId(formData.get("dealId"));
    if (!dealId) return { error: "That project could not be identified." };

    const site = text(formData.get("site"), 120);
    const startsOn = isoDate(formData.get("startsOn"));
    const dueOn = isoDate(formData.get("dueOn"));

    /* A job that finishes before it starts is a typo, and catching it here is
       cheaper than explaining a negative duration on a report later. */
    if (startsOn && dueOn && dueOn < startsOn) {
      return { error: "The due date is before the start date." };
    }

    const row = await q.one<{ id: string }>(
      `UPDATE deals
          SET site = $3, starts_on = $4::date, due_on = $5::date, updated_at = now()
        WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL
        RETURNING id`,
      [q.ctx.subAccountId, dealId, site || null, startsOn, dueOn]
    );
    if (!row) return { error: "That project no longer exists." };

    revalidateApp();
    return { ok: "Project updated." };
  });
}

/**
 * Put somebody on the job.
 *
 * One form for both sides: the value arrives as `us:<userId>` or
 * `client:<contactId>`, because a single select of "everybody who could be on
 * this" is one decision for the person using it rather than two lists and a
 * choice about which to look in.
 *
 * The unique indexes are what actually stop a double entry; this turns their
 * error into a sentence.
 */
export async function addProjectPersonAction(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  return withCurrentTenant(async (q) => {
    const dealId = validId(formData.get("dealId"));
    if (!dealId) return { error: "That project could not be identified." };

    const raw = text(formData.get("person"), 140);
    const [side, personId] = raw.split(":");
    if ((side !== "us" && side !== "client") || !validId(personId)) {
      return { error: "Choose somebody to add." };
    }
    const roleOnJob = text(formData.get("roleOnJob"), 80);

    /* The deal is confirmed to be in this tenant before anything is written.
       Row level security would refuse the insert anyway, but the message it
       produces is a constraint violation rather than a sentence. */
    const deal = await q.one<{ id: string }>(
      `SELECT id FROM deals WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL`,
      [q.ctx.subAccountId, dealId]
    );
    if (!deal) return { error: "That project no longer exists." };

    try {
      await q.rows(
        `INSERT INTO project_people (id, sub_account_id, deal_id, user_id, contact_id, role_on_job)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          newId("pp"),
          q.ctx.subAccountId,
          dealId,
          side === "us" ? personId : null,
          side === "client" ? personId : null,
          roleOnJob || null,
        ]
      );
    } catch (err) {
      if (String(err).includes("project_people_")) {
        return { error: "They are already on this project." };
      }
      throw err;
    }

    revalidateApp();
    return { ok: "Added to the project." };
  });
}

/** Take somebody off. A hard delete: being on a job is a fact, not a record. */
export async function removeProjectPersonAction(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  return withCurrentTenant(async (q) => {
    const personRowId = validId(formData.get("id"));
    if (!personRowId) return { error: "That person could not be identified." };

    const gone = await q.one<{ id: string }>(
      `DELETE FROM project_people WHERE id = $2 AND sub_account_id = $1 RETURNING id`,
      [q.ctx.subAccountId, personRowId]
    );
    if (!gone) return { error: "They are no longer on this project." };

    revalidateApp();
    return { ok: "Removed from the project." };
  });
}

/**
 * Raise a quotation or a purchase order.
 *
 * Lines arrive as three parallel arrays from the form — description, quantity,
 * unit — and are zipped here. Blank rows are dropped rather than rejected: a
 * form that offers five line slots and refuses to submit until all five are
 * filled is a form that fights the person using it.
 *
 * The document and its lines are written in one call, so a quotation cannot
 * exist with its lines half-inserted. `withCurrentTenant` runs everything
 * inside one transaction, which is what makes that true.
 */
export async function createDocumentAction(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  return withCurrentTenant(async (q) => {
    const dealId = validId(formData.get("dealId"));
    const kind = pick(formData.get("kind"), DOC_KINDS);
    const number = text(formData.get("number"), 40);
    if (!dealId) return { error: "That project could not be identified." };
    if (!kind) return { error: "Choose a document type." };
    if (!number) return { error: "Give it a number, so it matches your accounts." };

    const status = pick(formData.get("status"), DOC_STATUSES) ?? "draft";
    const party = text(formData.get("party"), 120);
    const issuedOn = isoDate(formData.get("issuedOn"));
    const notes = multiline(formData.get("notes"), 1000);

    const descriptions = formData.getAll("lineDescription").map((v) => text(v, 200));
    const quantities = formData.getAll("lineQuantity");
    const units = formData.getAll("lineUnit");

    /*
       Both of these are decimals, and both were wrong.

       `count` rounds to an integer, so a line of 3.5 days was stored as 4 —
       a purchase order that went out at $58,000 instead of $50,750, with the
       form accepting the number and silently changing it. `money` rounds to
       whole units, so a unit price of $12,000.50 became $12,001 before it was
       ever converted to cents.

       Three decimal places for quantity, matching NUMERIC(14,3) on the column,
       so nothing is accepted here and then rounded again by the database.
    */
    const lines = descriptions
      .map((description, i) => ({
        description,
        // A quantity of zero is meaningful — a line included at no charge —
        // so only a MISSING quantity falls back to one.
        quantity: decimal(quantities[i], 1_000_000, 3) ?? 1,
        unitCents: Math.round((decimal(units[i], MAX_UNIT_PRICE, 2) ?? 0) * 100),
      }))
      .filter((l) => l.description !== "");

    /* A line whose numbers could not be read is refused outright rather than
       quietly priced at zero. A quotation is a document somebody signs. */
    const unreadable = descriptions.some(
      (description, i) =>
        description !== "" &&
        (decimal(quantities[i], 1_000_000, 3) === null ||
          decimal(units[i], MAX_UNIT_PRICE, 2) === null)
    );
    if (unreadable) {
      return { error: "A quantity or unit price could not be read as a number." };
    }

    if (lines.length === 0) {
      return { error: "Add at least one line, so the document has a total." };
    }

    const deal = await q.one<{ id: string }>(
      `SELECT id FROM deals WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL`,
      [q.ctx.subAccountId, dealId]
    );
    if (!deal) return { error: "That project no longer exists." };

    const documentId = newId(kind === "quote" ? "q" : kind === "purchase_order" ? "po" : "inv");
    try {
      await q.rows(
        `INSERT INTO documents (id, sub_account_id, deal_id, kind, number, status, party, issued_on, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9)`,
        [documentId, q.ctx.subAccountId, dealId, kind, number, status, party || null, issuedOn, notes || null]
      );
    } catch (err) {
      if (String(err).includes("documents_number_once")) {
        return { error: `You already have a ${kind === "quote" ? "quotation" : "document"} numbered ${number}.` };
      }
      throw err;
    }

    for (const [position, line] of lines.entries()) {
      await q.rows(
        `INSERT INTO document_lines
           (id, sub_account_id, document_id, description, quantity, unit_cents, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [newId("l"), q.ctx.subAccountId, documentId, line.description, line.quantity, line.unitCents, position]
      );
    }

    revalidateApp();
    return { ok: `${number} saved with ${lines.length} ${lines.length === 1 ? "line" : "lines"}.` };
  });
}

/**
 * Move a document along: draft → sent → accepted, or declined.
 *
 * Its own action rather than a general edit, because this is the change that
 * actually gets made day to day and it should be one click from the list.
 */
export async function setDocumentStatusAction(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  return withCurrentTenant(async (q) => {
    const documentId = validId(formData.get("documentId"));
    const status = pick(formData.get("status"), DOC_STATUSES);
    if (!documentId) return { error: "That document could not be identified." };
    if (!status) return { error: "Choose a status." };

    const row = await q.one<{ number: string }>(
      `UPDATE documents SET status = $3, updated_at = now()
        WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL
        RETURNING number`,
      [q.ctx.subAccountId, documentId, status]
    );
    if (!row) return { error: "That document no longer exists." };

    revalidateApp();
    return { ok: `${row.number} marked ${status}.` };
  });
}
