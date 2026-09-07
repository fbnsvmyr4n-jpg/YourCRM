import { listForEntity, logActivity } from "../repos/activity";
import { createContact, getContact, listContacts } from "../repos/contacts";
import type { ContactRecord } from "../repos/contacts";
import { email as validEmail, multiline, text } from "../validate";
import type { AnyTool, ToolDefinition, ToolResult } from "./gateway";
import { buildRegistry } from "./gateway";

/**
 * What an agent may actually do to this CRM.
 *
 * Each tool is domain-specific and narrow, which is the specification's rule and
 * worth restating: there is no `update_anything(table, fields)` here, and there
 * never will be. A wide tool moves the decision about what may be written from
 * this file — where it can be read, reviewed and tested — into the model's
 * judgement, which is exactly the thing a gateway exists to stop.
 *
 * Two things every tool below has in common.
 *
 * **It returns what the CRM says, not what was asked for.** A tool that echoed
 * its own input would let the agent tell a caller their number was updated when
 * the write silently did nothing.
 *
 * **It never returns more than the conversation needs.** A caller is an
 * outsider. `identify_caller` says whether we know them and what they are
 * called; it does not hand over their address, their deal values or their
 * history, because none of that is needed to say "hello Amara" and all of it is
 * a disclosure if the phone was stolen.
 */

/* ------------------------------------------------------------------ */
/* Shared parsing                                                      */
/* ------------------------------------------------------------------ */

const ok = <T>(value: T): ToolResult<T> => ({ ok: true, value });
const bad = (error: string): ToolResult<never> => ({ ok: false, error });

const asRecord = (raw: unknown): Record<string, unknown> =>
  raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

/**
 * Phone numbers, reduced to something comparable.
 *
 * Digits only, with a leading `+` preserved. Two people typing the same number
 * as "021 555 0142" and "+27215550142" must not become two contacts, and a
 * caller's number arrives from the carrier in a different shape from the one a
 * salesperson typed into a form.
 *
 * Deliberately NOT a full E.164 normaliser: turning a local number into an
 * international one requires knowing the country, and guessing that wrong
 * matches the wrong person, which is worse than not matching at all. Comparison
 * is on the trailing digits instead, which is the part that does not change.
 */
export function normalisePhone(raw: string): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/[^\d]/g, "");
  return trimmed.startsWith("+") ? `+${digits}` : digits;
}

/** The last nine digits, which survive country and trunk prefixes. */
export function phoneTail(raw: string): string {
  const digits = normalisePhone(raw).replace(/^\+/, "");
  return digits.slice(-9);
}

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

export type IdentifiedCaller =
  | { known: false; reason: "no_match" | "ambiguous"; candidates?: { name: string }[] }
  | {
      known: true;
      contactId: string;
      name: string;
      company: string | null;
      isClient: boolean;
    };

const identifyCaller: ToolDefinition<{ phone: string }, IdentifiedCaller> = {
  name: "identify_caller",
  description:
    "Look up who is calling from their phone number. Returns their name if this workspace knows " +
    "them, or tells you it could not identify them. Call this once at the start of a call.",
  purpose: "Match an inbound number to a contact.",
  inputSchema: {
    type: "object",
    properties: { phone: { type: "string", description: "The caller's number, as the carrier gave it." } },
    required: ["phone"],
    additionalProperties: false,
  },
  parse: (raw) => {
    const phone = text(asRecord(raw).phone, 40);
    if (!phone) return bad("No phone number was given.");
    if (phoneTail(phone).length < 7) return bad("That is not enough of a phone number to search on.");
    return ok({ phone });
  },
  capability: "read_crm",
  risk: "auto",
  retryable: true,
  run: async (q, { phone }) => {
    const tail = phoneTail(phone);
    const contacts = await listContacts(q);
    const matches = contacts.filter((c) => c.phone && phoneTail(c.phone) === tail);

    if (matches.length === 0) return ok({ known: false, reason: "no_match" });

    /*
       Two people on one number is a real thing — a switchboard, a shared mobile,
       a couple. The specification is explicit that we never silently merge, and
       the honest behaviour here is to hand back the names and let the agent ask
       which one it is speaking to.
    */
    if (matches.length > 1) {
      return ok({
        known: false,
        reason: "ambiguous",
        candidates: matches.slice(0, 5).map((c) => ({ name: fullName(c) })),
      });
    }

    const contact = matches[0];
    return ok({
      known: true,
      contactId: contact.id,
      name: fullName(contact),
      company: contact.companyName,
      isClient: contact.isClient,
    });
  },
};

const fullName = (c: ContactRecord) => `${c.firstName} ${c.lastName}`.trim();

const lookUpContact: ToolDefinition<{ name: string }, { matches: { contactId: string; name: string; company: string | null }[] }> = {
  name: "search_contacts",
  description:
    "Find people in this workspace by name, when the caller names somebody — themselves, a " +
    "colleague, or who they are asking about. Returns at most five matches.",
  purpose: "Name search across contacts.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
    additionalProperties: false,
  },
  parse: (raw) => {
    const name = text(asRecord(raw).name, 80);
    /* Two characters matches half the address book and tells the agent nothing;
       refusing is more useful than a list of twenty names read aloud. */
    if (name.length < 3) return bad("Give at least three characters to search on.");
    return ok({ name });
  },
  capability: "read_crm",
  risk: "auto",
  retryable: true,
  run: async (q, { name }) => {
    const needle = name.toLowerCase();
    const matches = (await listContacts(q))
      .filter((c) => fullName(c).toLowerCase().includes(needle))
      .slice(0, 5)
      .map((c) => ({ contactId: c.id, name: fullName(c), company: c.companyName }));
    return ok({ matches });
  },
};

/* ------------------------------------------------------------------ */
/* Writing what happened                                               */
/* ------------------------------------------------------------------ */

const addNote: ToolDefinition<
  { contactId: string; note: string },
  { noteId: string; contact: string }
> = {
  name: "add_contact_note",
  description:
    "Record something the caller told you against their contact record — a requirement, a " +
    "complaint, a change of circumstances. Use their exact meaning; do not embellish.",
  purpose: "Write a note onto a contact's history.",
  inputSchema: {
    type: "object",
    properties: {
      contactId: { type: "string", description: "From identify_caller or search_contacts." },
      note: { type: "string", description: "What they said, in one or two sentences." },
    },
    required: ["contactId", "note"],
    additionalProperties: false,
  },
  parse: (raw) => {
    const r = asRecord(raw);
    const contactId = text(r.contactId, 100);
    const note = multiline(r.note, 1000);
    if (!contactId) return bad("Which contact is this about?");
    if (!note) return bad("There is nothing to write down.");
    return ok({ contactId, note });
  },
  capability: "write_activity",
  risk: "auto",
  retryable: false,
  run: async (q, { contactId, note }, principal) => {
    /* The contact is confirmed to exist and to be ours before anything is
       written. Row-level security would refuse a foreign id anyway, but the
       error it produces is a constraint violation rather than something an
       agent can say out loud. */
    const contact = await getContact(q, contactId);
    if (!contact) return bad("That contact is not in this workspace.");

    const activity = await logActivity(q, {
      entityType: "contact",
      entityId: contactId,
      kind: "note",
      title: "Noted on a call",
      detail: note,
      actorUserId: principal.userId,
    });
    return ok({ noteId: activity.id, contact: fullName(contact) });
  },
};

const recentActivity: ToolDefinition<
  { contactId: string },
  { entries: { what: string; when: string }[] }
> = {
  name: "get_recent_activity",
  description:
    "What has happened with this contact lately, so you do not ask about something already " +
    "dealt with. Returns the last five entries only.",
  purpose: "Recent history for one contact.",
  inputSchema: {
    type: "object",
    properties: { contactId: { type: "string" } },
    required: ["contactId"],
    additionalProperties: false,
  },
  parse: (raw) => {
    const contactId = text(asRecord(raw).contactId, 100);
    if (!contactId) return bad("Which contact?");
    return ok({ contactId });
  },
  capability: "read_crm",
  risk: "auto",
  retryable: true,
  run: async (q, { contactId }) => {
    const contact = await getContact(q, contactId);
    if (!contact) return bad("That contact is not in this workspace.");
    /* Five, and titles only. A full history read down the phone is both useless
       and a disclosure; the agent needs enough to avoid repeating itself. The
       repository returns the whole history, so the trim happens here rather
       than being pushed into a shared read other screens depend on. */
    const entries = (await listForEntity(q, "contact", contactId))
      .slice(0, 5)
      .map((a) => ({ what: a.title, when: a.at.slice(0, 10) }));
    return ok({ entries });
  },
};

/* ------------------------------------------------------------------ */
/* Capturing somebody new                                              */
/* ------------------------------------------------------------------ */

const captureContact: ToolDefinition<
  { firstName: string; lastName: string; phone: string; email: string | null; company: string | null },
  { contactId: string; name: string }
> = {
  name: "create_contact",
  description:
    "Add a caller this workspace does not know yet. Only call this once you have their name " +
    "from them — never invent one, and never guess a spelling you were not given.",
  purpose: "Create a contact from a call.",
  inputSchema: {
    type: "object",
    properties: {
      firstName: { type: "string" },
      lastName: { type: "string" },
      phone: { type: "string" },
      email: { type: "string" },
      company: { type: "string" },
    },
    required: ["firstName", "phone"],
    additionalProperties: false,
  },
  parse: (raw) => {
    const r = asRecord(raw);
    const firstName = text(r.firstName, 60);
    const lastName = text(r.lastName, 60);
    const phone = text(r.phone, 40);
    if (!firstName) return bad("A contact needs at least a first name.");
    if (!phone) return bad("A contact created from a call needs the number they rang from.");

    /* An unparseable address is refused rather than stored: a wrong email on a
       record is worse than none, because somebody will send a quotation to it. */
    const emailRaw = text(r.email, 254);
    const email = emailRaw ? validEmail(emailRaw) : "";
    if (email === null) return bad("That email address could not be read back correctly.");

    return ok({
      firstName,
      lastName,
      phone,
      email: email || null,
      company: text(r.company, 120) || null,
    });
  },
  capability: "write_contact",
  /* A new person in somebody's CRM is not something to do on an inference. The
     caller has to have agreed to being added. */
  risk: "confirm",
  retryable: false,
  run: async (q, input) => {
    /* Last check before writing: did somebody get created between identifying
       and now — a second call on the same number, a colleague typing it in?
       Creating the duplicate is exactly what entity resolution exists to
       prevent. */
    const tail = phoneTail(input.phone);
    const existing = (await listContacts(q)).find((c) => c.phone && phoneTail(c.phone) === tail);
    if (existing) {
      return ok({ contactId: existing.id, name: fullName(existing) });
    }

    const contact = await createContact(q, {
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email ?? "",
      phone: input.phone,
      info: input.company ?? "",
    });
    return ok({ contactId: contact.id, name: fullName(contact) });
  },
};

/* ------------------------------------------------------------------ */
/* The registry                                                        */
/* ------------------------------------------------------------------ */

export const CRM_TOOLS: AnyTool[] = [
  identifyCaller,
  lookUpContact,
  recentActivity,
  addNote,
  captureContact,
];

export const CRM_TOOL_REGISTRY = buildRegistry(CRM_TOOLS);
