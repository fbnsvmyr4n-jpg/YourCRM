"use server";

import { revalidateApp } from "@/server/revalidate";
import { LEAD_SOURCES } from "@/data/leads";
import { createContact, deleteContact, updateContact } from "@/server/repos/contacts";
import { createDeal, listDealsForContact, updateDeal, type Source } from "@/server/repos/deals";
import { SOURCE_VALUE } from "@/server/leads-view";
import { withCurrentTenant } from "@/server/tenant-session";
import { email as validEmail, id as validId, pick, text } from "@/server/validate";
import { logWrite } from "@/server/log";

/**
 * Lead actions, without a leads table.
 *
 * Capturing a lead now creates two things: the person, and the opportunity
 * that makes them a lead. That is not extra bookkeeping — it is the same two
 * facts the old model stored, minus the duplicate copy of the person that
 * nothing kept in step with the contact record.
 *
 * `status` is still deliberately not read from the form. It is derived from
 * the deal's stage, so accepting one here would let a posted value contradict
 * what actually happened.
 */

type Parsed = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  location: string;
  company: string;
  source: Source;
};

/** Returns null when the submission cannot be trusted, so the caller rejects it. */
function parseLead(formData: FormData): Parsed | null {
  const name = text(formData.get("name"), 80);
  const email = validEmail(formData.get("email"));
  const source = pick(formData.get("source"), LEAD_SOURCES);

  // Source drives the breakdown on this page and the revenue attribution on
  // Reports — an unrecognised value there silently corrupts both.
  if (!name || email === null || !source) return null;

  const parts = name.trim().split(/\s+/);
  return {
    firstName: parts[0] ?? name,
    lastName: parts.slice(1).join(" "),
    email,
    phone: text(formData.get("phone"), 40),
    location: text(formData.get("location"), 80),
    company: text(formData.get("company"), 80),
    /* Imported rather than declared here. This was a second hand-kept map
       pointing the other way, and it covered the same four of seven sources —
       so "Website" chosen in the form was stored as `other`. It is now the
       inverse of the single table the page reads. */
    source: SOURCE_VALUE[source],
  };
}

export async function addLeadAction(formData: FormData) {
  return withCurrentTenant(async (q) => {
    const input = parseLead(formData);
    if (!input) return null;

    const contact = await createContact(q, {
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      phone: input.phone,
      location: input.location,
      info: input.company,
      ownerUserId: q.ctx.userId,
    });

    // The opportunity is what makes them a lead rather than a name on file.
    // It starts at Prospect and moves on its own as events land.
    await createDeal(q, {
      title: `${`${input.firstName} ${input.lastName}`.trim()} — enquiry`,
      contactId: contact.id,
      stage: "prospect",
      source: input.source,
      ownerUserId: q.ctx.userId,
    });

    revalidateApp();
    return contact.id;
  });
}

export async function updateLeadAction(id: string, formData: FormData) {
  return withCurrentTenant(async (q) => {
    const contactId = validId(id);
    const input = parseLead(formData);
    if (!contactId || !input) return;

    await updateContact(q, contactId, {
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      phone: input.phone,
      location: input.location,
      info: input.company,
    });

    // Source lives on the deal, because that is what attribution is about.
    // Applied to their earliest live opportunity — the one this page shows.
    const [earliest] = (await listDealsForContact(q, contactId))
      .filter((d) => d.stage !== "lost")
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    if (earliest) {
      await updateDeal(q, earliest.id, { source: input.source });
    }

    revalidateApp();
  });
}

export async function deleteLeadAction(id: string) {
  return withCurrentTenant(async (q) => {
    const contactId = validId(id);
    if (!contactId) return;

    /**
     * Removes the person, not just their pipeline entry.
     *
     * The old action deleted a lead record while the matching contact — if
     * there was one — stayed behind, which is how the two tables drifted apart
     * in the first place. Soft, so it is recoverable, and their deals keep
     * their history rather than being destroyed alongside them.
     *
     * Nothing needs detaching afterwards either: calls point at contacts and
     * deals by foreign key, so a soft delete cannot leave a dangling claim the
     * way removing a lead row did.
     */
    if (await deleteContact(q, contactId)) {
      logWrite("delete", "contact", { id: contactId, actor: q.ctx.userId, detail: "from Leads" });
    }
    revalidateApp();
  });
}
