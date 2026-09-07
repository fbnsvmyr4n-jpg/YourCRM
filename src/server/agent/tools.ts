import { listForEntity, logActivity } from "../repos/activity";
import { createContact, getContact, listContacts } from "../repos/contacts";
import type { ContactRecord } from "../repos/contacts";
import { createDeal } from "../repos/deals";
import { createMeeting, listBetween } from "../repos/meetings";
import { listPriceItems } from "../repos/pricing";
import { draftQuote, quotesNeedingUser } from "../repos/quotes";
import { getSettings } from "../repos/settings";
import { instantToWallClock, wallClockToInstant } from "@/lib/zoned";
import { decimal, email as validEmail, multiline, text } from "../validate";
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
/* Following up                                                        */
/*                                                                     */
/* The specification's registry lists create_task / complete_task, and  */
/* this CRM has no such entity — `repos/tasks.ts` is a PROJECT'S task   */
/* list, which is a different thing entirely. Rather than invent a      */
/* to-do table for the agent's benefit, these map onto what a follow-up */
/* already IS here: an enquiry is a deal, and a commitment to speak     */
/* again is a meeting. That is the spec's own instruction where the     */
/* existing architecture is sound, and it means a call the agent takes  */
/* lands on the same board the sales team already works from.           */
/* ------------------------------------------------------------------ */

const logEnquiry: ToolDefinition<
  { contactId: string; wants: string; valueHint: number | null },
  { dealId: string; title: string }
> = {
  name: "log_enquiry",
  description:
    "Record that this caller is asking about a piece of work, so it appears on the sales board. " +
    "Use their own words for what they want. Only give a value if they stated a budget out loud.",
  purpose: "Create a deal from an inbound enquiry.",
  inputSchema: {
    type: "object",
    properties: {
      contactId: { type: "string" },
      wants: { type: "string", description: "What they are asking for, in a few words." },
      valueHint: { type: "number", description: "Only if the caller stated a budget. Omit otherwise." },
    },
    required: ["contactId", "wants"],
    additionalProperties: false,
  },
  parse: (raw) => {
    const r = asRecord(raw);
    const contactId = text(r.contactId, 100);
    const wants = text(r.wants, 120);
    if (!contactId) return bad("Which contact is this for?");
    if (!wants) return bad("What are they asking about?");

    /* A budget is only ever what somebody said. `decimal` rather than `count`
       because "about two and a half thousand" is a real answer, and rounding a
       stated budget is changing what they told us. */
    const raw2 = r.valueHint;
    const value = raw2 === undefined || raw2 === null || raw2 === "" ? null : decimal(raw2, 100_000_000, 2);
    if (value === null && raw2 !== undefined && raw2 !== null && raw2 !== "") {
      return bad("That budget figure could not be read as a number.");
    }
    return ok({ contactId, wants, valueHint: value });
  },
  capability: "write_activity",
  risk: "auto",
  retryable: false,
  run: async (q, { contactId, wants, valueHint }, principal) => {
    const contact = await getContact(q, contactId);
    if (!contact) return bad("That contact is not in this workspace.");

    const deal = await createDeal(q, {
      title: `${fullName(contact)} — ${wants}`,
      contactId,
      /* Cents, converted once here. The tool takes whole currency units because
         that is what a person says out loud. */
      valueCents: valueHint === null ? 0 : Math.round(valueHint * 100),
      stage: "prospect",
      /* The real source, from the enum the pipeline already uses. */
      source: "phone_call",
      ownerUserId: principal.userId,
    });
    return ok({ dealId: deal.id, title: deal.title });
  },
};

const whenAreWeFree: ToolDefinition<
  { date: string },
  { date: string; busy: { from: string; to: string }[] }
> = {
  name: "check_availability",
  description:
    "What is already booked on a given day, so you do not offer a slot that is taken. " +
    "Give the date as YYYY-MM-DD. Times come back in this business's own time zone.",
  purpose: "Read the day's meetings before offering a time.",
  inputSchema: {
    type: "object",
    properties: { date: { type: "string", description: "YYYY-MM-DD" } },
    required: ["date"],
    additionalProperties: false,
  },
  parse: (raw) => {
    const date = text(asRecord(raw).date, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad("Give the date as YYYY-MM-DD.");
    return ok({ date });
  },
  capability: "read_crm",
  risk: "auto",
  retryable: true,
  run: async (q, { date }) => {
    const { timeZone } = await getSettings(q);
    /*
       The day's boundaries are resolved in the BUSINESS's zone, not the
       server's. A UTC server asked about a Johannesburg Tuesday would otherwise
       return two hours of Monday evening and miss two hours of Tuesday night —
       and the agent would offer a slot that is already taken.
    */
    const from = wallClockToInstant(date, "00:00", timeZone);
    const to = wallClockToInstant(date, "23:59", timeZone);
    if (!from || !to) return bad("That date could not be read.");

    const busy = (await listBetween(q, from, to)).map((m) => {
      const start = instantToWallClock(m.scheduledAt, timeZone);
      const endsAt = new Date(Date.parse(m.scheduledAt) + m.durationMin * 60_000).toISOString();
      const end = instantToWallClock(endsAt, timeZone);
      return { from: start?.time ?? "?", to: end?.time ?? "?" };
    });
    return ok({ date, busy });
  },
};

const bookMeeting: ToolDefinition<
  { contactId: string; date: string; time: string; topic: string; durationMin: number },
  { meetingId: string; when: string; topic: string }
> = {
  name: "create_meeting",
  description:
    "Book a time to speak. Check availability first. Only call this once the caller has agreed " +
    "to the specific day and time out loud — read it back to them before you do.",
  purpose: "Book a meeting from a call.",
  inputSchema: {
    type: "object",
    properties: {
      contactId: { type: "string" },
      date: { type: "string", description: "YYYY-MM-DD" },
      time: { type: "string", description: "HH:MM, 24-hour, in the business's own time zone" },
      topic: { type: "string" },
      durationMin: { type: "number", description: "Defaults to 30." },
    },
    required: ["contactId", "date", "time", "topic"],
    additionalProperties: false,
  },
  parse: (raw) => {
    const r = asRecord(raw);
    const contactId = text(r.contactId, 100);
    const date = text(r.date, 10);
    const time = text(r.time, 5);
    const topic = text(r.topic, 120);
    if (!contactId) return bad("Who is the meeting with?");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad("Give the date as YYYY-MM-DD.");
    if (!/^\d{2}:\d{2}$/.test(time)) return bad("Give the time as HH:MM on a 24-hour clock.");
    if (!topic) return bad("What is the meeting about?");

    const minutes = r.durationMin === undefined ? 30 : decimal(r.durationMin, 480, 0);
    if (minutes === null || minutes < 5) return bad("That duration could not be read as minutes.");
    return { ok: true, value: { contactId, date, time, topic, durationMin: minutes } };
  },
  capability: "write_meeting",
  /* A time in somebody's diary, agreed with a customer. The caller has to have
     said yes to this exact slot — which is why the description tells the agent
     to read it back first. */
  risk: "confirm",
  retryable: false,
  run: async (q, input) => {
    const contact = await getContact(q, input.contactId);
    if (!contact) return bad("That contact is not in this workspace.");

    const { timeZone } = await getSettings(q);
    /*
       Resolved to an instant ONCE, here, in the business's zone. The call
       record already learned this lesson: a relative or zone-less time stored
       raw is only true on the day it was written.
    */
    const scheduledAt = wallClockToInstant(input.date, input.time, timeZone);
    if (!scheduledAt) return bad("That date and time could not be read.");

    const meeting = await createMeeting(q, {
      topic: input.topic,
      scheduledAt,
      durationMin: input.durationMin,
      contactId: input.contactId,
      /* `online` because the follow-up is a call back, and the meeting kinds
         this CRM knows are online or in person. Not a third value invented for
         the agent's convenience — a stage or kind nobody's screen renders is
         how a record becomes invisible. */
      kind: "online",
      notes: "Booked by the voice agent during a call.",
    });
    const when = instantToWallClock(meeting.scheduledAt, timeZone);
    return ok({
      meetingId: meeting.id,
      when: `${when?.date ?? input.date} ${when?.time ?? input.time}`,
      topic: meeting.topic,
    });
  },
};

/* ------------------------------------------------------------------ */
/* Quotations                                                          */
/*                                                                     */
/* There is no send tool here, and there is none anywhere else either.  */
/* A quotation an agent produced waits for a named person in the CRM to */
/* approve it, and the caller is the party it would be sent TO — they   */
/* can never be the one who approves it. That property already holds    */
/* for the chat agent; the phone does not get an exception.             */
/* ------------------------------------------------------------------ */

const draftAQuote: ToolDefinition<
  { dealId: string; items: { item: string; quantity: number }[] },
  { number: string; total: string; lines: number; status: string }
> = {
  name: "create_quote_draft",
  description:
    "Draft a quotation for a job, priced from this workspace's price list. Every line must name " +
    "an item on that list — you cannot set a price yourself. The draft does NOT go to the " +
    "customer: it waits for someone here to approve it. Tell the caller that is what happens.",
  purpose: "Draft a quotation for human approval.",
  inputSchema: {
    type: "object",
    properties: {
      dealId: { type: "string", description: "From log_enquiry." },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            item: { type: "string", description: "The price list item's name." },
            quantity: { type: "number" },
          },
          required: ["item"],
        },
      },
    },
    required: ["dealId", "items"],
    additionalProperties: false,
  },
  parse: (raw) => {
    const r = asRecord(raw);
    const dealId = text(r.dealId, 100);
    if (!dealId) return bad("Which job is this quote for?");
    if (!Array.isArray(r.items) || r.items.length === 0) {
      return bad("A quotation needs at least one line.");
    }
    if (r.items.length > 20) return bad("That is too many lines for one quotation over the phone.");

    const items: { item: string; quantity: number }[] = [];
    for (const entry of r.items as unknown[]) {
      const e = asRecord(entry);
      const item = text(e.item, 120);
      if (!item) return bad("A quotation line has to name a price list item.");
      const quantity = e.quantity === undefined || e.quantity === null ? 1 : decimal(e.quantity, 1_000_000, 3);
      if (quantity === null) return bad(`The quantity for "${item}" could not be read as a number.`);
      items.push({ item, quantity });
    }
    return ok({ dealId, items });
  },
  capability: "draft_quote",
  /* The tier that means a person in the CRM decides. Not `confirm` — the caller
     agreeing is not the same as the business agreeing to a price. */
  risk: "approve",
  retryable: false,
  run: async (q, { dealId, items }) => {
    const prices = await listPriceItems(q, true);
    if (prices.length === 0) {
      return bad("There is nothing on the price list, so no quotation can be priced.");
    }

    const lines = [];
    for (const wanted of items) {
      const needle = wanted.item.toLowerCase();
      const matches = prices.filter(
        (p) => p.name.toLowerCase() === needle || p.name.toLowerCase().includes(needle)
      );
      /* Refused rather than guessed, and the alternatives are named so the
         agent can offer a real one instead of inventing a price. */
      if (matches.length !== 1) {
        return bad(
          `"${wanted.item}" is not one thing on the price list. It has: ${prices.map((p) => p.name).join(", ")}.`
        );
      }
      lines.push({
        description: matches[0].name,
        quantity: wanted.quantity,
        unitCents: matches[0].unitCents,
      });
    }

    const { quote, error } = await draftQuote(q, {
      dealId,
      partyContactId: null,
      party: null,
      notes: "Asked for on a call.",
      lines,
      agent: "voice",
    });
    if (!quote) return bad(error ?? "The quotation could not be drafted.");

    return ok({
      number: quote.number,
      total: `${(quote.totalCents / 100).toFixed(2)}`,
      lines: quote.lines.length,
      status: "waiting for approval — not sent",
    });
  },
};

const quotesWaiting: ToolDefinition<
  Record<string, never>,
  { waiting: { number: string; project: string; total: string }[] }
> = {
  name: "list_quotes_awaiting_approval",
  description:
    "Quotations already drafted and waiting for someone here to approve them. Use this when a " +
    "caller asks what has happened to a quote — never guess at its status.",
  purpose: "Read pending quotations.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  parse: () => ok({}),
  capability: "read_crm",
  risk: "auto",
  retryable: true,
  run: async (q) => {
    const waiting = (await quotesNeedingUser(q)).map((quote) => ({
      number: quote.number,
      project: quote.projectTitle,
      total: `${(quote.totalCents / 100).toFixed(2)}`,
    }));
    return ok({ waiting });
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
  logEnquiry,
  whenAreWeFree,
  bookMeeting,
  draftAQuote,
  quotesWaiting,
];

export const CRM_TOOL_REGISTRY = buildRegistry(CRM_TOOLS);
