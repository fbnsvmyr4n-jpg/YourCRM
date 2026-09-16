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
import { findOrCreateCompany } from "@/server/repos/companies";
import type { TenantQuery } from "@/server/tenant";
import { email as validEmail, id as validId, multiline, pick, text } from "@/server/validate";
import { logWrite } from "@/server/log";
import { importContacts, previewImport } from "@/server/import-contacts";
import { applyCustomValues, parseCustomValues } from "@/server/custom-field-form";
import {
  BULK_LIMIT,
  bulkAssignOwner,
  bulkDeleteContacts,
  bulkSetCompany,
} from "@/server/repos/contacts";
import {
  createTag,
  deleteTag,
  deleteView,
  findTagByName,
  listTags,
  saveView,
  setTagOnContacts,
  updateTag,
} from "@/server/repos/tags";
import {
  cleanName,
  MAX_TAG_NAME,
  MAX_VIEW_NAME,
  parseFilter,
  TAG_COLORS,
  type SavedView,
  type Tag,
} from "@/server/contact-filter";
import { roleCan } from "@/server/permissions";

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

/**
 * Turn the company somebody typed into the company record it names.
 *
 * This field used to be a label and nothing else. The name went into `info`,
 * `company_id` stayed null, and the contact was filed under nobody — which was
 * invisible on the contact card, since the card cheerfully showed the name, and
 * surfaced two screens away instead. A deal takes its company FROM ITS CONTACT,
 * so a real deal, for a real person, at a company that already existed under
 * that exact name, never appeared on Projects at all: the page said "No
 * projects yet" while the work sat in the pipeline.
 *
 * Resolved case-insensitively against the companies that exist and created when
 * nothing matches — the same rule the Add company dialog already promises, so
 * typing a name that exists files the contact there instead of making a second
 * company with different capitals.
 *
 * ONLY the short `company` field feeds this. `info` also carries free-form
 * notes for contacts written before those two were separated, and creating a
 * company named after a paragraph is precisely the mess the companies entity
 * was introduced to clear up.
 *
 * An empty field clears the link: somebody deleting a company name means the
 * person no longer works there, and leaving them filed under the old client
 * would keep their work showing on that client's page.
 */
async function companyIdFrom(q: TenantQuery, formData: FormData): Promise<string | null> {
  const name = text(formData.get("company"), 80);
  if (!name) return null;
  const company = await findOrCreateCompany(q, name);
  return company?.id ?? null;
}

export async function addContactAction(formData: FormData) {
  return withCurrentTenant(async (q) => {
    const input = parseContact(formData);
    if (!input) return;

    /* Before anything is written, so a bad value refuses the whole save
       rather than leaving a person created without it. */
    const custom = await parseCustomValues(q, "contact", formData);
    if ("error" in custom) return { error: custom.error };

    // Ownership comes from the session, never the form. A client could
    // otherwise claim any owner it liked — and the database now refuses an
    // owner from outside this tenant regardless.
    const created = await createContact(q, {
      ...input,
      companyId: await companyIdFrom(q, formData),
      ownerUserId: q.ctx.userId,
    });
    await applyCustomValues(q, "contact", created.id, custom);

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

    const custom = await parseCustomValues(q, "contact", formData);
    if ("error" in custom) return { error: custom.error };

    await updateContact(q, contactId, {
      ...input,
      companyId: await companyIdFrom(q, formData),
    });
    const customChanged = await applyCustomValues(q, "contact", contactId, custom);

    // Name the fields that changed rather than logging a bare "updated" — the
    // point of a history is being able to see what somebody actually did.
    const changed = [
      ...(["firstName", "lastName", "email", "phone", "location"] as const).filter(
        (k) => String(before[k] ?? "") !== String(input[k] ?? "")
      ),
      ...customChanged,
    ];

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


/** How much CSV the server will read in one go. */
const MAX_IMPORT_BYTES = 5_000_000;

/**
 * Look at an uploaded file without writing anything.
 *
 * A mapping that put phone numbers in the email column is obvious on ten
 * sample rows and invisible in a summary, so the person sees the rows before
 * anything touches their account.
 */
export async function previewImportAction(formData: FormData) {
  return withCurrentTenant(async (q) => {
    const csv = String(formData.get("csv") ?? "");
    if (!csv.trim()) return { error: "Choose a CSV file." };
    if (csv.length > MAX_IMPORT_BYTES) {
      // Named with the actual limit. "File too large" leaves somebody
      // guessing whether to split it into two or twenty.
      return { error: `That file is over ${MAX_IMPORT_BYTES / 1_000_000}MB. Split it and import each part.` };
    }

    const preview = await previewImport(q, csv);
    if (preview.total === 0 && preview.issues.length === 0) {
      return { error: "No rows found. Is the first line a header?" };
    }
    return { ok: true as const, preview };
  });
}

/**
 * Import the file.
 *
 * The whole import runs in one tenant transaction: a failure part-way leaves
 * nothing behind, rather than half a contact list nobody can tell apart from a
 * whole one.
 */
export async function importContactsAction(formData: FormData) {
  return withCurrentTenant(async (q) => {
    const csv = String(formData.get("csv") ?? "");
    if (!csv.trim()) return { error: "Choose a CSV file." };
    if (csv.length > MAX_IMPORT_BYTES) {
      return { error: `That file is over ${MAX_IMPORT_BYTES / 1_000_000}MB. Split it and import each part.` };
    }

    const result = await importContacts(q, csv, { ownerUserId: q.ctx.userId });

    logWrite("create", "contact_import", {
      id: q.ctx.subAccountId,
      detail: `${result.imported} imported, ${result.skipped} skipped`,
    });
    revalidateApp();
    return { ok: true as const, ...result };
  });
}


/**
 * Bulk actions.
 *
 * Every one reports how many rows it actually changed, not how many were
 * selected. An id from another workspace matches nothing, and saying "12
 * updated" when 12 were selected and 9 changed is the kind of confident wrong
 * number that stops anybody checking.
 */
type BulkResult = { error: string } | { ok: true; changed: number };

/** Ids arrive from a browser: cleaned, capped, and de-duplicated here. */
function readIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids = raw
    .map((v) => (typeof v === "string" ? validId(v) : null))
    .filter((v): v is string => !!v);
  return [...new Set(ids)].slice(0, BULK_LIMIT);
}

export async function bulkAssignContactsAction(
  ids: string[],
  ownerUserId: string | null
): Promise<BulkResult> {
  return withCurrentTenant(async (q) => {
    const clean = readIds(ids);
    if (clean.length === 0) return { error: "Nothing selected." };

    const owner = ownerUserId ? validId(ownerUserId) : null;
    if (ownerUserId && !owner) return { error: "That person is not on this account." };

    const changed = await bulkAssignOwner(q, clean, owner);
    logWrite("update", "contact", { id: `${changed} contacts`, detail: "bulk assign" });
    revalidateApp();
    return { ok: true as const, changed };
  });
}

export async function bulkSetCompanyAction(
  ids: string[],
  companyId: string | null
): Promise<BulkResult> {
  return withCurrentTenant(async (q) => {
    const clean = readIds(ids);
    if (clean.length === 0) return { error: "Nothing selected." };

    const company = companyId ? validId(companyId) : null;
    if (companyId && !company) return { error: "That company no longer exists." };

    const changed = await bulkSetCompany(q, clean, company);
    if (changed === 0 && company) {
      // The company predicate is all-or-nothing, so zero changed with a company
      // named means the company itself was rejected — worth saying, rather than
      // reporting a cheerful "0 updated".
      return { error: "That company no longer exists." };
    }
    logWrite("update", "contact", { id: `${changed} contacts`, detail: "bulk company" });
    revalidateApp();
    return { ok: true as const, changed };
  });
}

/** Put a tag on — or take it off — every selected contact. */
export async function bulkTagContactsAction(ids: string[], tagId: string, on: boolean): Promise<BulkResult> {
  return withCurrentTenant(async (q) => {
    const clean = readIds(ids);
    if (clean.length === 0) return { error: "Nothing selected." };
    const tag = validId(tagId);
    if (!tag || !(await listTags(q)).some((t) => t.id === tag)) return { error: "That tag no longer exists." };

    const changed = await setTagOnContacts(q, tag, clean, on === true);
    logWrite("update", "contact", { id: `${changed} contacts`, detail: on ? "bulk tag" : "bulk untag" });
    revalidateApp();
    return { ok: true as const, changed };
  });
}

export async function bulkDeleteContactsAction(ids: string[]): Promise<BulkResult> {
  return withCurrentTenant(async (q) => {
    const clean = readIds(ids);
    if (clean.length === 0) return { error: "Nothing selected." };

    const changed = await bulkDeleteContacts(q, clean);
    logWrite("delete", "contact", { id: `${changed} contacts`, detail: "bulk delete" });
    revalidateApp();
    return { ok: true as const, changed };
  });
}

/* ------------------------------------------------------------------ */
/* Tags                                                                */
/*                                                                     */
/* Anybody who works the contacts can label them, make a new label as   */
/* they type, and save a view — that is the work. Renaming, recolouring */
/* or deleting a label changes it on every contact for everybody, so    */
/* that is for whoever manages the team, like the shape of the record.  */
/* ------------------------------------------------------------------ */

const NOT_YOUR_TAGS = "Only somebody who manages the team can rename or delete a tag.";

type TagResult = { error: string } | { ok: true; tag: Tag };

/**
 * Tag one contact, with an existing tag or one named as it is typed.
 *
 * A typed name that matches an existing tag in any case reuses it, so "cape
 * town" does not quietly become a second Cape Town.
 */
export async function addTagToContactAction(
  contactId: string,
  input: { tagId?: string; name?: string; color?: string }
): Promise<TagResult> {
  return withCurrentTenant(async (q) => {
    const id = validId(contactId);
    const contact = id ? await getContact(q, id) : null;
    if (!id || !contact) return { error: "That contact no longer exists." };

    const tags = await listTags(q);
    let tag: Tag | null = null;
    if (input.tagId !== undefined) {
      const tagId = validId(input.tagId);
      tag = tags.find((t) => t.id === tagId) ?? null;
      if (!tag) return { error: "That tag no longer exists." };
    } else {
      const name = cleanName(input.name, MAX_TAG_NAME);
      if (!name) return { error: "Type a name for the tag." };
      tag = await findTagByName(q, name);
      if (!tag) {
        /* A colour nobody has used yet where there is one, so a new tag reads
           as different from the last at a glance. */
        const used = new Set(tags.map((t) => t.color));
        const color =
          pick(input.color, TAG_COLORS) ?? TAG_COLORS.find((c) => !used.has(c)) ?? TAG_COLORS[tags.length % TAG_COLORS.length];
        const made = await createTag(q, name, color);
        if ("error" in made) return { error: made.error };
        tag = made.tag;
        logWrite("create", "tag", { id: tag.id, actor: q.ctx.userId });
      }
    }

    const changed = await setTagOnContacts(q, tag.id, [id], true);
    if (changed > 0) {
      await logActivity(q, {
        entityType: "contact",
        entityId: id,
        kind: "updated",
        title: "Tag added",
        detail: tag.name,
        actorUserId: q.ctx.userId,
      });
    }
    revalidateApp();
    return { ok: true as const, tag };
  });
}

export async function removeTagFromContactAction(contactId: string, tagId: string): Promise<{ error: string } | { ok: true }> {
  return withCurrentTenant(async (q) => {
    const id = validId(contactId);
    const tag = validId(tagId);
    if (!id || !tag) return { error: "That tag is not on this contact." };
    const name = (await listTags(q)).find((t) => t.id === tag)?.name;

    const changed = await setTagOnContacts(q, tag, [id], false);
    if (changed > 0 && name) {
      await logActivity(q, {
        entityType: "contact",
        entityId: id,
        kind: "updated",
        title: "Tag removed",
        detail: name,
        actorUserId: q.ctx.userId,
      });
    }
    revalidateApp();
    return { ok: true as const };
  });
}

export async function updateTagAction(tagId: string, name: string, color: string): Promise<{ error: string } | { ok: true }> {
  return withCurrentTenant(async (q) => {
    if (!roleCan(q.ctx.role, "manage_users")) return { error: NOT_YOUR_TAGS };
    const id = validId(tagId);
    if (!id) return { error: "That tag no longer exists." };
    const clean = cleanName(name, MAX_TAG_NAME);
    if (!clean) return { error: "A tag needs a name." };
    const tone = pick(color, TAG_COLORS);
    if (!tone) return { error: "Choose one of the colours." };

    const out = await updateTag(q, id, { name: clean, color: tone });
    if ("error" in out) return out;
    logWrite("update", "tag", { id, actor: q.ctx.userId });
    revalidateApp();
    return out;
  });
}

/** The label comes off every contact. The contacts themselves are untouched. */
export async function deleteTagAction(tagId: string): Promise<{ error: string } | { ok: true }> {
  return withCurrentTenant(async (q) => {
    if (!roleCan(q.ctx.role, "manage_users")) return { error: NOT_YOUR_TAGS };
    const id = validId(tagId);
    if (!id || !(await deleteTag(q, id))) return { error: "That tag no longer exists." };
    logWrite("delete", "tag", { id, actor: q.ctx.userId });
    revalidateApp();
    return { ok: true as const };
  });
}

/** Saved for the whole workspace: a view is how a team agrees what "hot leads" means. */
export async function saveViewAction(name: string, filter: unknown): Promise<{ error: string } | { ok: true; view: SavedView }> {
  return withCurrentTenant(async (q) => {
    const clean = cleanName(name, MAX_VIEW_NAME);
    if (!clean) return { error: "Give the view a name." };
    const parsed = parseFilter(filter, new Set((await listTags(q)).map((t) => t.id)));
    if (parsed.type === "all" && parsed.tagIds.length === 0) {
      return { error: "Choose a type or a tag first — this view would show everybody." };
    }
    const out = await saveView(q, clean, parsed);
    if ("error" in out) return out;
    logWrite("create", "contact_view", { id: out.view.id, actor: q.ctx.userId });
    revalidateApp();
    return { ok: true as const, view: out.view };
  });
}

/** Whoever saved a view may delete it, and so may whoever manages the team. */
export async function deleteViewAction(viewId: string): Promise<{ error: string } | { ok: true }> {
  return withCurrentTenant(async (q) => {
    const id = validId(viewId);
    const row = id
      ? await q.one<{ created_by_user_id: string | null }>(
          `SELECT created_by_user_id FROM contact_views WHERE sub_account_id = $1 AND id = $2`,
          [q.ctx.subAccountId, id]
        )
      : null;
    if (!id || !row) return { error: "That view no longer exists." };
    if (row.created_by_user_id !== q.ctx.userId && !roleCan(q.ctx.role, "manage_users")) {
      return { error: "Only whoever saved this view, or somebody who manages the team, can delete it." };
    }
    if (!(await deleteView(q, id))) return { error: "That view no longer exists." };
    logWrite("delete", "contact_view", { id, actor: q.ctx.userId });
    revalidateApp();
    return { ok: true as const };
  });
}
