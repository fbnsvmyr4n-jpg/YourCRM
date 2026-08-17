"use server";

import { revalidateApp } from "@/server/revalidate";
import { CONTACT_STATUSES, CONTACT_TYPES } from "@/data/contacts";
import {
  createContact,
  deleteContact,
  getContact,
  updateContact,
  type NewContact,
} from "@/server/contacts-repo";
import { deleteActivity, logActivity } from "@/server/activity-repo";
import { getCurrentUser, requireUser } from "@/server/session";
import { email as validEmail, id as validId, multiline, pick, text } from "@/server/validate";
import { logWrite } from "@/server/log";

/** Returns null when the submission can't be trusted, so the caller rejects it. */
function parseContact(formData: FormData): NewContact | null {
  const firstName = text(formData.get("firstName"), 60);
  const lastName = text(formData.get("lastName"), 60);
  const email = validEmail(formData.get("email"));
  const type = pick(formData.get("type"), CONTACT_TYPES);
  const status = pick(formData.get("status"), CONTACT_STATUSES);

  // `type` decides whether someone is a client or a lead — it drives the
  // contacts donut on Reports and the client/lead counts on the dashboard.
  if ((!firstName && !lastName) || email === null || !type || !status) return null;

  return {
    firstName,
    lastName,
    email,
    phone: text(formData.get("phone"), 40),
    company: text(formData.get("company"), 80),
    companyInfo: multiline(formData.get("companyInfo"), 1000),
    type,
    status,
  };
}

export async function addContactAction(formData: FormData) {
  await requireUser();
  const input = parseContact(formData);
  if (!input) return;

  // Ownership comes from the session, never the form — a client could otherwise
  // claim any owner it liked, and the old code hardcoded one name for everyone.
  const user = await getCurrentUser();
  const created = await createContact({ ...input, owner: user?.name || "Unassigned" });

  await logActivity({
    contactId: created.id,
    kind: "created",
    title: `Contact created${user?.name ? ` by ${user.name}` : ""}`,
  });

  revalidateApp();
  return created.id;
}

/* ------------------------------------------------------------------ */
/* The action buttons                                                  */
/*                                                                     */
/* Call / Text / Email open the right app on the user's device — the    */
/* client builds the tel:, sms: or mailto: URL — and these record that  */
/* it happened, so Contact Activity reflects real work rather than      */
/* fixtures. Every one of these six was previously inert.               */
/* ------------------------------------------------------------------ */

/** Records an outreach attempt. Returns null if the contact isn't real. */
export async function logOutreachAction(id: string, kind: "call" | "text" | "email") {
  await requireUser();
  const contactId = validId(id);
  if (!contactId) return null;

  const contact = await getContact(contactId);
  if (!contact) return null;

  const user = await getCurrentUser();
  const titles = {
    call: `Called ${contact.phone || "— no number on file"}`,
    text: `Texted ${contact.phone || "— no number on file"}`,
    email: `Emailed ${contact.email || "— no address on file"}`,
  } as const;

  const entry = await logActivity({
    contactId,
    kind,
    title: titles[kind],
    detail: user?.name ? `by ${user.name}` : undefined,
  });

  revalidateApp();
  return entry;
}

export async function addNoteAction(id: string, formData: FormData) {
  await requireUser();
  const contactId = validId(id);
  const body = multiline(formData.get("note"), 2000);
  if (!contactId || !body) return null;

  const contact = await getContact(contactId);
  if (!contact) return null;

  const entry = await logActivity({ contactId, kind: "note", title: "Note", detail: body });
  revalidateApp();
  return entry;
}

export async function deleteActivityAction(contactId: string, activityId: string) {
  const actor = await requireUser();
  const cid = validId(contactId);
  const aid = validId(activityId);
  if (!cid || !aid) return;
  await deleteActivity(cid, aid);
  // Removing a timeline entry erases history, so the removal is itself history.
  logWrite("delete", "activity", { id: aid, actor: actor.id, detail: `contact ${cid}` });
  revalidateApp();
}

export async function updateContactAction(id: string, formData: FormData) {
  await requireUser();
  const contactId = validId(id);
  const input = parseContact(formData);
  if (!contactId || !input) return;

  const before = await getContact(contactId);
  await updateContact(contactId, input);

  // Name the fields that changed rather than logging a bare "updated" — the
  // point of a history is being able to see what someone actually did.
  if (before) {
    const changed = (["firstName", "lastName", "email", "phone", "company", "type", "status"] as const)
      .filter((k) => String(before[k] ?? "") !== String(input[k] ?? ""));

    if (changed.length) {
      const user = await getCurrentUser();
      await logActivity({
        contactId,
        kind: "updated",
        title: `Details updated${user?.name ? ` by ${user.name}` : ""}`,
        detail: changed.join(", "),
      });
    }
  }

  revalidateApp();
}

export async function deleteContactAction(id: string) {
  const actor = await requireUser();
  const contactId = validId(id);
  if (!contactId) return;
  await deleteContact(contactId);
  logWrite("delete", "contact", { id: contactId, actor: actor.id });
  revalidateApp();
}
