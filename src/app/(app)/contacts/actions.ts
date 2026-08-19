"use server";

import { revalidateApp } from "@/server/revalidate";
import {
  assignOwner,
  createContact,
  deleteContact,
  getContact,
  restoreContact,
  updateContact,
  type NewContact,
} from "@/server/repos/contacts";
import { logActivity } from "@/server/repos/activity";
import { withCurrentTenant } from "@/server/tenant-session";
import { email as validEmail, id as validId, multiline, text } from "@/server/validate";
import { logWrite } from "@/server/log";

/**
 * Contact actions, on the relational schema.
 *
 * Every one of these starts with `withCurrentTenant`, which resolves the
 * session AND the customer being acted for before any SQL runs. That replaces
 * the previous `requireUser()` — not as a shortcut, but because an action that
 * has established which customer it is acting for has necessarily established
 * who is asking, and the previous version established only the second half.
 *
 * `type` and `status` are gone from the form. They were stored claims about a
 * person's sales position that disagreed with their deals often enough to be
 * useless; a contact is now a lead or a client because of what their deals say.
 * Nothing was lost — the two fields simply stopped being editable fiction.
 */

/** Returns null when the submission cannot be trusted, so the caller rejects it. */
function parseContact(formData: FormData): NewContact | null {
  const firstName = text(formData.get("firstName"), 60);
  const lastName = text(formData.get("lastName"), 60);
  const email = validEmail(formData.get("email"));

  // A person with no name at all is not a record anybody can use; a bad email
  // is a typo worth rejecting rather than storing.
  if ((!firstName && !lastName) || email === null) return null;

  return {
    firstName,
    lastName,
    email,
    phone: text(formData.get("phone"), 40),
    location: text(formData.get("location"), 120),
    info: multiline(formData.get("companyInfo"), 1000) || text(formData.get("company"), 80),
  };
}

export async function addContactAction(formData: FormData) {
  return withCurrentTenant(async (q) => {
    const input = parseContact(formData);
    if (!input) return;

    // Ownership comes from the session, never the form. A client could
    // otherwise claim any owner it liked — and the database now refuses an
    // owner from outside this tenant regardless.
    const created = await createContact(q, { ...input, ownerUserId: q.ctx.userId });

    await logActivity(q, {
      entityType: "contact",
      entityId: created.id,
      kind: "created",
      title: "Contact created",
      actorUserId: q.ctx.userId,
    });

    revalidateApp();
    return created.id;
  });
}

/* ------------------------------------------------------------------ */
/* The action buttons                                                  */
/*                                                                     */
/* Call / Text / Email open the right app on the user's device — the    */
/* client builds the tel:, sms: or mailto: URL — and these record that  */
/* it happened, so Contact Activity reflects real work rather than      */
/* fixtures.                                                            */
/* ------------------------------------------------------------------ */

/** Records an outreach attempt. Returns null if the contact is not real. */
export async function logOutreachAction(id: string, kind: "call" | "text" | "email") {
  return withCurrentTenant(async (q) => {
    const contactId = validId(id);
    if (!contactId) return null;

    // Reading it back inside the tenant is the authorisation check: a contact
    // belonging to somebody else simply is not there.
    const contact = await getContact(q, contactId);
    if (!contact) return null;

    const titles = {
      call: `Called ${contact.phone || "— no number on file"}`,
      text: `Texted ${contact.phone || "— no number on file"}`,
      email: `Emailed ${contact.email || "— no address on file"}`,
    } as const;

    const entry = await logActivity(q, {
      entityType: "contact",
      entityId: contactId,
      kind,
      title: titles[kind],
      actorUserId: q.ctx.userId,
    });

    revalidateApp();
    return entry;
  });
}

export async function addNoteAction(id: string, formData: FormData) {
  return withCurrentTenant(async (q) => {
    const contactId = validId(id);
    const body = multiline(formData.get("note"), 2000);
    if (!contactId || !body) return null;

    const contact = await getContact(q, contactId);
    if (!contact) return null;

    const entry = await logActivity(q, {
      entityType: "contact",
      entityId: contactId,
      kind: "note",
      title: "Note",
      detail: body,
      actorUserId: q.ctx.userId,
    });
    revalidateApp();
    return entry;
  });
}

export async function updateContactAction(id: string, formData: FormData) {
  return withCurrentTenant(async (q) => {
    const contactId = validId(id);
    const input = parseContact(formData);
    if (!contactId || !input) return;

    const before = await getContact(q, contactId);
    if (!before) return;

    await updateContact(q, contactId, input);

    // Name the fields that changed rather than logging a bare "updated" — the
    // point of a history is being able to see what somebody actually did.
    const changed = (["firstName", "lastName", "email", "phone", "location"] as const).filter(
      (k) => String(before[k] ?? "") !== String(input[k] ?? "")
    );

    if (changed.length) {
      await logActivity(q, {
        entityType: "contact",
        entityId: contactId,
        kind: "updated",
        title: "Details updated",
        detail: changed.join(", "),
        actorUserId: q.ctx.userId,
      });
    }

    revalidateApp();
  });
}

/** Hand a contact to a colleague, or take it back. */
export async function assignContactAction(id: string, ownerUserId: string | null) {
  return withCurrentTenant(async (q) => {
    const contactId = validId(id);
    if (!contactId) return { error: "That contact is not valid." };

    const owner = ownerUserId ? validId(ownerUserId) : null;
    if (ownerUserId && !owner) return { error: "That person is not valid." };

    const { record, error } = await assignOwner(q, contactId, owner);
    if (error) return { error };

    await logActivity(q, {
      entityType: "contact",
      entityId: contactId,
      kind: "updated",
      title: owner ? "Owner changed" : "Owner cleared",
      actorUserId: q.ctx.userId,
    });

    revalidateApp();
    return { ok: true as const, ownerUserId: record?.ownerUserId ?? null };
  });
}

export async function deleteContactAction(id: string) {
  return withCurrentTenant(async (q) => {
    const contactId = validId(id);
    if (!contactId) return;

    // Soft delete: recoverable, and the history stays. The old version removed
    // the row outright and then deleted its activity in a second lock.
    const removed = await deleteContact(q, contactId);
    if (removed) {
      logWrite("delete", "contact", { id: contactId, actor: q.ctx.userId });
    }
    revalidateApp();
  });
}

/** The other half of a soft delete, which the old hard delete could not offer. */
export async function restoreContactAction(id: string) {
  return withCurrentTenant(async (q) => {
    const contactId = validId(id);
    if (!contactId) return;
    const restored = await restoreContact(q, contactId);
    if (restored) {
      logWrite("restore", "contact", { id: contactId, actor: q.ctx.userId });
    }
    revalidateApp();
  });
}
