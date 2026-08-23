"use server";

import { logActivity } from "@/server/repos/activity";
import {
  findOrCreateCompany,
  removeCompany,
  renameCompany,
} from "@/server/repos/companies";
import { logWrite } from "@/server/log";
import { revalidateApp } from "@/server/revalidate";
import { withCurrentTenant } from "@/server/tenant-session";
import { id as validId, text } from "@/server/validate";

/**
 * Managing companies.
 *
 * The screen exists because the backfill had to turn an overloaded text column
 * into rows, and that column had been used for two different things — company
 * names for some contacts, notes for others. Roughly half the companies it
 * produced are not companies. Without a way to rename or remove them the entity
 * is worse than the string it replaced: the same mess, now in a list of its own.
 */

export async function renameCompanyAction(id: string, formData: FormData) {
  return withCurrentTenant(async (q) => {
    const companyId = validId(id);
    const name = text(formData.get("name"), 120);
    if (!companyId) return { error: "That company no longer exists." };
    if (!name) return { error: "Give the company a name." };

    const updated = await renameCompany(q, companyId, name);
    if (!updated) return { error: "That company no longer exists." };

    logWrite("update", "company", { id: companyId, detail: name });
    revalidateApp();
    return { ok: true as const, name: updated.name };
  });
}

/**
 * Remove a company.
 *
 * Soft, and the contacts keep their records — they simply stop showing a
 * company. The first thing anybody does here is clear out rows that were never
 * companies, and a hard delete would make "I removed the wrong one"
 * unrecoverable.
 */
export async function removeCompanyAction(id: string) {
  return withCurrentTenant(async (q) => {
    const companyId = validId(id);
    if (!companyId) return { error: "That company no longer exists." };

    const removed = await removeCompany(q, companyId);
    if (!removed) return { error: "That company no longer exists." };

    logWrite("delete", "company", { id: companyId });
    revalidateApp();
    return { ok: true as const };
  });
}

export async function addCompanyAction(formData: FormData) {
  return withCurrentTenant(async (q) => {
    const name = text(formData.get("name"), 120);
    if (!name) return { error: "Give the company a name." };

    // Find-or-create, not create: typing a name that already exists should
    // take you to it rather than making a second one, which is the whole
    // reason this entity exists.
    const company = await findOrCreateCompany(q, name);
    if (!company) return { error: "That company could not be created." };

    logWrite("create", "company", { id: company.id, detail: company.name });
    revalidateApp();
    return { ok: true as const, id: company.id, name: company.name };
  });
}

/** Move one contact to a company, or off one. */
export async function setContactCompanyAction(contactId: string, companyId: string | null) {
  return withCurrentTenant(async (q) => {
    const person = validId(contactId);
    if (!person) return { error: "That contact no longer exists." };

    const target = companyId ? validId(companyId) : null;
    if (companyId && !target) return { error: "That company no longer exists." };

    // Both ids are checked against this workspace by the UPDATE's own
    // predicates — a company id from another tenant matches nothing and the
    // statement changes no rows, rather than moving somebody into a stranger's
    // account.
    const row = await q.one<{ id: string }>(
      `UPDATE contacts SET company_id = $3, updated_at = now()
       WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL
         AND ($3::text IS NULL OR EXISTS (
           SELECT 1 FROM companies co
           WHERE co.id = $3 AND co.sub_account_id = $1 AND co.deleted_at IS NULL
         ))
       RETURNING id`,
      [q.ctx.subAccountId, person, target]
    );
    if (!row) return { error: "That contact could not be moved." };

    await logActivity(q, {
      entityType: "contact",
      entityId: person,
      kind: "note",
      title: target ? "Moved to a different company" : "Removed from their company",
      actorUserId: q.ctx.userId,
    });

    revalidateApp();
    return { ok: true as const };
  });
}
