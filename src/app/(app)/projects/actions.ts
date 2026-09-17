"use server";

import { logWrite } from "@/server/log";
import { applyCustomValues, parseCustomValues } from "@/server/custom-field-form";
import { cascade } from "@/server/repos/tasks";
import { revalidateApp } from "@/server/revalidate";
import { requireTenant, withCurrentTenant } from "@/server/tenant-session";
import { count, decimal, id as validId, multiline, pick, text } from "@/server/validate";

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

    /* Checked before the deal is touched, so a bad value saves nothing. */
    const custom = await parseCustomValues(q, "deal", formData);
    if ("error" in custom) return { error: custom.error };

    const row = await q.one<{ id: string }>(
      `UPDATE deals
          SET site = $3, starts_on = $4::date, due_on = $5::date, updated_at = now()
        WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL
        RETURNING id`,
      [q.ctx.subAccountId, dealId, site || null, startsOn, dueOn]
    );
    if (!row) return { error: "That project no longer exists." };
    await applyCustomValues(q, "deal", dealId, custom);

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

    /*
       Raised from a stage of the job: every line is filed there.

       Checked against THIS project, and before anything is written. The trigger
       on document_lines would refuse a stage from another project too — but only
       at the first line, after the document itself had been saved, which would
       leave a document with no lines behind. The trigger stays as the guarantee;
       this is what keeps a refusal clean.
    */
    const rawStage = String(formData.get("projectTaskId") ?? "").trim();
    const stageId = rawStage ? validId(rawStage) : null;
    if (rawStage && !stageId) return { error: "That stage could not be identified." };
    let stageName: string | null = null;
    if (stageId) {
      const stage = await q.one<{ name: string }>(
        `SELECT name FROM project_tasks
          WHERE sub_account_id = $1 AND id = $2 AND deal_id = $3 AND deleted_at IS NULL`,
        [q.ctx.subAccountId, stageId, dealId]
      );
      if (!stage) return { error: "That stage is not part of this project." };
      stageName = stage.name;
    }

    const documentId = newId(kind === "quote" ? "q" : kind === "purchase_order" ? "po" : "inv");
    try {
      /* Inside a savepoint. A duplicate number is refused by the unique index,
         and catching that error without one leaves the whole transaction
         aborted — every statement after it answers "current transaction is
         aborted". Nothing runs after this catch today, so it was harmless by
         luck rather than by design; the next line anyone adds here would have
         failed on exactly the input a person is most likely to retry. */
      await q.attempt(() =>
        q.rows(
          `INSERT INTO documents (id, sub_account_id, deal_id, kind, number, status, party, issued_on, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9)`,
          [documentId, q.ctx.subAccountId, dealId, kind, number, status, party || null, issuedOn, notes || null]
        )
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
           (id, sub_account_id, document_id, description, quantity, unit_cents, position, project_task_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [newId("l"), q.ctx.subAccountId, documentId, line.description, line.quantity, line.unitCents, position, stageId]
      );
    }

    revalidateApp();
    const saved = `${number} saved with ${lines.length} ${lines.length === 1 ? "line" : "lines"}`;
    return { ok: stageName ? `${saved}, filed to ${stageName}.` : `${saved}.` };
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

    /*
       A quotation waiting on an approval is not moved along from here.

       `DOC_STATUSES` cannot express `awaiting_approval` or `approved`, so
       without this predicate any Update on such a document rewrote it to
       whichever value the select happened to be showing — throwing away a
       pending approval, or marking an unsent quote sent. The screen hides the
       control; this is what makes hiding it true, because a server action is a
       public endpoint and the screen is only a suggestion.
    */
    const row = await q.one<{ number: string }>(
      `UPDATE documents SET status = $3, updated_at = now()
        WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL
          AND status NOT IN ('awaiting_approval', 'approved')
        RETURNING number`,
      [q.ctx.subAccountId, documentId, status]
    );
    if (!row) {
      const doc = await q.one<{ number: string; status: string }>(
        `SELECT number, status FROM documents
          WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL`,
        [q.ctx.subAccountId, documentId]
      );
      if (!doc) return { error: "That document no longer exists." };
      return {
        error: `${doc.number} is waiting on an approval. Approve or discard it in Chat first.`,
      };
    }

    revalidateApp();
    return { ok: `${row.number} marked ${status}.` };
  });
}

/* ------------------------------------------------------------------ */
/* The schedule                                                        */
/*                                                                     */
/* A project's tasks: what the work actually is, and how far along.    */
/* Same gate as everything above — a schedule is customer data, so IT  */
/* and accounts are refused by construction rather than by a check.    */
/* ------------------------------------------------------------------ */

/** A percentage arriving from a form. Not `count`: 0 is meaningful and 100 is the cap. */
function percent(value: unknown): number {
  const n = Number(text(value, 8));
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
}

export async function addTaskAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return withCurrentTenant(async (q) => {
    const dealId = validId(formData.get("dealId"));
    if (!dealId) return { error: "That project could not be identified." };

    const name = text(formData.get("name"), 140);
    if (!name) return { error: "Give the task a name." };

    const { addTask } = await import("@/server/repos/tasks");
    const result = await addTask(q, dealId, {
      name,
      startsOn: isoDate(formData.get("startsOn")),
      dueOn: isoDate(formData.get("dueOn")),
      percentComplete: percent(formData.get("percentComplete")),
      ownerUserId: validId(formData.get("ownerUserId")),
    });
    if (result.error) return { error: result.error };

    revalidateApp();
    return { ok: `${result.task?.name} added to the schedule.` };
  });
}

export async function updateTaskAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return withCurrentTenant(async (q) => {
    const taskId = validId(formData.get("taskId"));
    if (!taskId) return { error: "That task could not be identified." };

    const name = text(formData.get("name"), 140);
    if (!name) return { error: "Give the task a name." };

    const { updateTask } = await import("@/server/repos/tasks");
    const result = await updateTask(q, taskId, {
      name,
      startsOn: isoDate(formData.get("startsOn")),
      dueOn: isoDate(formData.get("dueOn")),
      percentComplete: percent(formData.get("percentComplete")),
      ownerUserId: validId(formData.get("ownerUserId")),
    });
    if (result.error) return { error: result.error };

    /*
       Moving a date is the whole reason dependencies exist, so the plan is
       settled immediately rather than on the next page load. Saying HOW MANY
       tasks moved matters: dates somebody typed have just been rewritten, and
       a screen that changes six rows without mentioning it is a screen people
       stop trusting.
    */
    const dealId = validId(formData.get("dealId"));
    const moved = dealId ? await cascade(q, dealId) : 0;

    revalidateApp();
    return {
      ok:
        moved > 0
          ? `${result.task?.name} updated — ${moved} later ${moved === 1 ? "task" : "tasks"} moved with it.`
          : `${result.task?.name} updated.`,
    };
  });
}

/**
 * Tick a task off, or reopen it.
 *
 * The change that actually gets made day to day, so it is one press from the
 * schedule rather than a trip through the edit form.
 */
export async function setTaskCompleteAction(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  return withCurrentTenant(async (q) => {
    const taskId = validId(formData.get("taskId"));
    if (!taskId) return { error: "That task could not be identified." };
    const done = formData.get("done") === "true";

    const { setTaskComplete } = await import("@/server/repos/tasks");
    const result = await setTaskComplete(q, taskId, done);
    if (result.error) return { error: result.error };

    revalidateApp();
    return { ok: done ? `${result.task?.name} marked done.` : `${result.task?.name} reopened.` };
  });
}

export async function moveTaskAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return withCurrentTenant(async (q) => {
    const dealId = validId(formData.get("dealId"));
    const taskId = validId(formData.get("taskId"));
    const direction = pick(formData.get("direction"), ["up", "down"] as const);
    if (!dealId || !taskId) return { error: "That task could not be identified." };
    if (!direction) return { error: "Choose a direction." };

    const { moveTask } = await import("@/server/repos/tasks");
    const moved = await moveTask(q, dealId, taskId, direction);
    /* Not an error. Pressing up on the first row is a no-op, and telling
       somebody off for it would be noise on a control they will press by
       accident every day. */
    if (!moved) return undefined;

    revalidateApp();
    return undefined;
  });
}

export async function deleteTaskAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return withCurrentTenant(async (q) => {
    const taskId = validId(formData.get("taskId"));
    if (!taskId) return { error: "That task could not be identified." };

    const { deleteTask } = await import("@/server/repos/tasks");
    const gone = await deleteTask(q, taskId);
    if (!gone) return { error: "That task is already gone." };

    /* A task vanishing off a schedule is exactly the sort of thing somebody
       asks about later. The id and the actor, and nothing about what it said —
       the log must never carry record contents. */
    logWrite("delete", "project_task", { id: taskId, actor: q.ctx.userId });
    revalidateApp();
    return { ok: "Removed from the schedule." };
  });
}

/**
 * Make one task wait for another.
 *
 * The dates follow immediately: that is the point of the link, and a
 * dependency that drew a line without moving anything would be decoration.
 */
export async function addDependencyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return withCurrentTenant(async (q) => {
    const dealId = validId(formData.get("dealId"));
    const taskId = validId(formData.get("taskId"));
    const dependsOnId = validId(formData.get("dependsOnId"));
    if (!dealId || !taskId) return { error: "That task could not be identified." };
    if (!dependsOnId) return { error: "Choose which task it waits for." };

    const lag = count(formData.get("lagDays"), 365) ?? 0;

    const { addDependency } = await import("@/server/repos/tasks");
    const result = await addDependency(q, dealId, taskId, dependsOnId, lag);
    if (result.error) return { error: result.error };

    revalidateApp();
    return {
      ok:
        result.moved && result.moved > 0
          ? `Linked — ${result.moved} ${result.moved === 1 ? "task" : "tasks"} moved to follow on.`
          : "Linked.",
    };
  });
}

/** Break a link. The dates it forced are left where they are, deliberately —
    unpicking a dependency is not a reason to move work somebody has planned. */
export async function removeDependencyAction(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  return withCurrentTenant(async (q) => {
    const linkId = validId(formData.get("linkId"));
    if (!linkId) return { error: "That link could not be identified." };

    const { removeDependency } = await import("@/server/repos/tasks");
    const gone = await removeDependency(q, linkId);
    if (!gone) return { error: "That link is already gone." };

    revalidateApp();
    return { ok: "No longer waiting on it." };
  });
}

/**
 * Lay the schedule out from the quotation somebody already approved.
 *
 * The Timeline asked for five fields per task and a real job has fifteen of
 * them — seventy-five inputs to retype work that was itemised when it was
 * quoted for. This reads those lines instead.
 */
export async function buildPlanAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return withCurrentTenant(async (q) => {
    const dealId = validId(formData.get("dealId"));
    if (!dealId) return { error: "That project could not be identified." };

    const { buildPlanFromQuote } = await import("@/server/plan-from-quote");
    const result = await buildPlanFromQuote(q, dealId);
    if (result.error) return { error: result.error };

    revalidateApp();
    /* The assumption is named rather than buried. A plan whose shape is right
       and whose lengths need checking is worth having; one mistaken for a
       considered estimate is not. */
    const assumed = result.assumed
      ? ` ${result.assumed} of them defaulted to a day because the quote does not say how long they take — check those.`
      : "";
    return {
      ok: `${result.created} tasks laid out from ${result.quoteNumber}, each waiting on the one before it.${assumed}`,
    };
  });
}

/**
 * File a document line against a stage of the job, or take it off one.
 *
 * The plan builder does this automatically for a quotation it laid out, but
 * most paperwork arrives the other way round: a supplier's purchase order,
 * typed in later, that somebody knows belongs to the crane hire. Without this
 * the link would only ever exist for documents the app generated itself, which
 * would make every stage's margin quietly wrong for every job run normally.
 *
 * An empty `projectTaskId` unfiles the line. The database refuses a task on a
 * different project, so a hand-edited form matches nothing rather than
 * counting one job's costs against another's margin.
 */
export async function fileLineAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return withCurrentTenant(async (q) => {
    const lineId = validId(formData.get("lineId"));
    if (!lineId) return { error: "That line could not be identified." };

    const raw = String(formData.get("projectTaskId") ?? "").trim();
    const taskId = raw ? validId(raw) : null;
    if (raw && !taskId) return { error: "That stage could not be identified." };

    try {
      const row = await q.one<{ id: string }>(
        `UPDATE document_lines SET project_task_id = $3
          WHERE sub_account_id = $1 AND id = $2
          RETURNING id`,
        [q.ctx.subAccountId, lineId, taskId]
      );
      if (!row) return { error: "That line no longer exists." };
    } catch (err) {
      /* The guard trigger, surfaced as something a person can read rather than
         a constraint name. It fires when a form names a task from another
         project — which is the case worth refusing, since it would put one
         job's costs in another job's margin. */
      if (String(err).includes("different project")) {
        return { error: "That stage belongs to a different project." };
      }
      throw err;
    }

    revalidateApp();
    return { ok: taskId ? "Filed against that stage." : "Taken off the stage." };
  });
}

/**
 * Raise an invoice for work the client has agreed to.
 *
 * Invoicing has been in the data model since documents were built — the kind
 * is allowed, `paid` is a status, the id prefix exists — and none of it was
 * reachable from the product. This is the transition the schema's own note
 * promised.
 */
export async function raiseInvoiceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return withCurrentTenant(async (q) => {
    const dealId = validId(formData.get("dealId"));
    if (!dealId) return { error: "That project could not be identified." };

    const { raiseInvoiceFromQuote } = await import("@/server/invoice-from-quote");
    const result = await raiseInvoiceFromQuote(q, dealId);
    if (result.error) return { error: result.error };

    logWrite("create", "invoice", { id: result.invoiceId, actor: q.ctx.userId });
    revalidateApp();
    return {
      ok: `${result.number} raised from ${result.fromQuote}, same lines and same figures. Check it, then send it.`,
    };
  });
}

/**
 * Send an invoice to the client.
 *
 * Queued rather than sent inline, like a quotation: a demand for payment that
 * vanishes because a mail server hiccuped is worse than one that arrives late.
 * The job is deduplicated per invoice, so pressing Send twice cannot bill a
 * client twice.
 *
 * Pressing this IS the human decision — there is no separate approval step,
 * because the approval gate in this product exists for figures an AI wrote,
 * and these were approved by a person and accepted by the client already.
 */
export async function sendInvoiceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await requireTenant();
  const documentId = validId(formData.get("documentId"));
  if (!documentId) return { error: "That invoice could not be identified." };

  const { findInvoice } = await import("@/server/repos/invoices");
  const { INVOICE_EMAIL, invoiceEmailKey, OUTBOX_REGISTRY } = await import("@/server/outbox-handlers");
  const { drain, queueJob } = await import("@/server/outbox");
  const { findJob } = await import("@/server/repos/outbox");

  const refusal = await withCurrentTenant(async (q) => {
    const invoice = await findInvoice(q, documentId);
    if (!invoice) return "That invoice no longer exists.";
    if (invoice.sentAt) return `${invoice.number} has already been sent.`;
    /* Said here as well as in the handler, because both need somebody to go and
       change something before any amount of retrying can help. */
    if (!invoice.partyEmail) {
      return `${invoice.number} has no email address for ${invoice.party ?? "that client"}. Add one to their contact and send it again.`;
    }
    await queueJob(q, OUTBOX_REGISTRY, {
      handler: INVOICE_EMAIL,
      payload: { documentId },
      dedupeKey: invoiceEmailKey(documentId),
    });
    return null;
  });
  if (refusal) return { error: refusal };

  /* Drained here so the common case is done before the user looks away; the
     queue is what guarantees it happens at all. */
  await drain(ctx, OUTBOX_REGISTRY, 5).catch(() => {});

  const after = await withCurrentTenant(async (q) => ({
    invoice: await findInvoice(q, documentId),
    job: await findJob(q, INVOICE_EMAIL, invoiceEmailKey(documentId)),
  }));

  if (after.invoice?.sentAt) {
    return { ok: `${after.invoice.number} sent to ${after.invoice.partyEmail}.` };
  }
  if (after.job?.status === "dead") {
    return {
      error: `${after.invoice?.number ?? "That invoice"} could not be sent: ${after.job.lastError ?? "unknown error"}`,
    };
  }
  return {
    ok: `${after.invoice?.number ?? "The invoice"} is queued to send. It hasn't gone out yet — we'll keep trying, and it will show in your notifications if it cannot be sent.`,
  };
}

/* ---------------- retainers ---------------- */

/** The furthest back a retainer may start. Further than that is an import, not a retainer. */
const MAX_BACKDATE_DAYS = 366;

async function readRetainerForm(formData: FormData, today: string) {
  const { addDays, isIsoDay, RETAINER_EVERY } = await import("@/server/retainer-rules");
  const description = text(formData.get("description"), 200);
  if (!description) return { error: "Say what the retainer is for — it becomes the invoice line." };

  const amount = decimal(formData.get("amount"), MAX_UNIT_PRICE, 2);
  if (amount === null || amount <= 0) return { error: "Enter the amount billed each period." };

  const every = pick(formData.get("every"), RETAINER_EVERY);
  if (!every) return { error: "Choose how often it is billed." };

  const startsOn = text(formData.get("startsOn"), 10);
  if (!isIsoDay(startsOn)) return { error: "Choose the date of the first invoice." };
  if (startsOn < addDays(today, -MAX_BACKDATE_DAYS)) {
    return { error: "A retainer can start at most a year back. Raise older invoices by hand." };
  }

  const endsRaw = text(formData.get("endsOn"), 10);
  if (endsRaw && !isIsoDay(endsRaw)) return { error: "That end date is not valid." };
  const endsOn = endsRaw || null;
  if (endsOn && endsOn < startsOn) return { error: "The end date is before the retainer starts." };

  const dueDays = count(formData.get("dueDays"), 120);
  if (dueDays === null) return { error: "Payment terms are between 0 and 120 days." };

  return { description, amountCents: Math.round(amount * 100), every, startsOn, endsOn, dueDays };
}

/**
 * Put a project on a retainer.
 *
 * Anything already due — a first invoice dated today — is raised in the same
 * press, so the person setting it up sees the draft rather than wondering when
 * it will appear.
 */
export async function createRetainerAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return withCurrentTenant(async (q) => {
    const dealId = validId(formData.get("dealId"));
    if (!dealId) return { error: "That project could not be identified." };
    const { businessToday } = await import("@/server/repos/settings");
    const { createRetainer, raiseDueRetainerInvoices } = await import("@/server/repos/retainers");
    const today = await businessToday(q);

    const input = await readRetainerForm(formData, today);
    if ("error" in input) return { error: input.error };

    const out = await createRetainer(q, dealId, input);
    if ("error" in out) return { error: out.error };
    logWrite("create", "retainer", { id: out.retainer.id, actor: q.ctx.userId });

    const raised = await raiseDueRetainerInvoices(q, today);
    revalidateApp();
    return {
      ok: raised.raised
        ? raised.raised === 1
          ? `Retainer set up. ${raised.numbers[0]} is ready as a draft — check it, then send it.`
          : `Retainer set up. ${raised.numbers.join(", ")} are ready as drafts — check them, then send them.`
        : "Retainer set up. Each invoice will be raised as a draft on its date for you to send.",
    };
  });
}

export async function updateRetainerAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return withCurrentTenant(async (q) => {
    const id = validId(formData.get("retainerId"));
    if (!id) return { error: "That retainer no longer exists." };
    const { businessToday } = await import("@/server/repos/settings");
    const { updateRetainer } = await import("@/server/repos/retainers");
    const input = await readRetainerForm(formData, await businessToday(q));
    if ("error" in input) return { error: input.error };

    const out = await updateRetainer(q, id, input);
    if ("error" in out) return { error: out.error };
    logWrite("update", "retainer", { id, actor: q.ctx.userId });
    revalidateApp();
    return { ok: "Saved. Invoices already raised keep their figures." };
  });
}

export async function setRetainerStatusAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return withCurrentTenant(async (q) => {
    const id = validId(formData.get("retainerId"));
    const { RETAINER_STATUSES, dayLabel } = await import("@/server/retainer-rules");
    const to = pick(formData.get("to"), RETAINER_STATUSES);
    if (!id || !to) return { error: "That change could not be made." };
    const { businessToday } = await import("@/server/repos/settings");
    const { setRetainerStatus } = await import("@/server/repos/retainers");

    const out = await setRetainerStatus(q, id, to, await businessToday(q));
    if ("error" in out) return { error: out.error };
    logWrite("update", "retainer", { id, actor: q.ctx.userId, detail: to });
    revalidateApp();
    return {
      ok:
        to === "paused"
          ? "Paused. Nothing is billed until you resume it."
          : to === "active"
            ? `Resumed. The next invoice is dated ${dayLabel(out.retainer.nextInvoiceOn)}.`
            : "Cancelled. Invoices already raised stay on the project.",
    };
  });
}

/* ---------------- taking payment ---------------- */

/**
 * The public pay link for a sent invoice, made the first time it is asked for.
 * The link is the invoice's own token; asking twice gives the same link.
 */
export async function invoicePayLinkAction(documentId: string): Promise<{ url: string } | { error: string }> {
  return withCurrentTenant(async (q) => {
    const id = validId(documentId);
    if (!id) return { error: "That invoice could not be identified." };
    const { ensurePayToken, getConnection } = await import("@/server/repos/payments");
    const { getSettings } = await import("@/server/repos/settings");
    const { paystackTakes } = await import("@/server/paystack");
    const { appUrl } = await import("@/server/billing/stripe");
    if (!(await getConnection(q))) return { error: "Connect Paystack in Settings → Payments first." };
    if (!paystackTakes((await getSettings(q)).currency)) return { error: "Paystack does not take this currency." };
    const { findInvoice } = await import("@/server/repos/invoices");
    if (!(await findInvoice(q, id))?.sentAt) return { error: "Send the invoice first; the link goes with it." };
    const token = await ensurePayToken(q, id);
    if (!token) return { error: "Only a sent, unpaid invoice has a pay link." };
    return { url: `${appUrl()}/pay/${token}` };
  });
}
