import { createDeal } from "./repos/deals";
import { createMeeting } from "./repos/meetings";
import { createContact, listContacts } from "./repos/contacts";
import { getCall, linkCall } from "./repos/calls";
import { logActivity } from "./repos/activity";
import type { TenantQuery } from "./tenant";

/**
 * Turn a handled call into records: a contact, an opportunity, and a meeting
 * if the caller asked for one.
 *
 * This used to live inside the calls repository, where reading a call created
 * a lead and a meeting as a side effect. That is orchestration across four
 * entities inside a leaf, so it moved out rather than being ported — a
 * repository that writes to three other tables is one nobody can reason about.
 *
 * Idempotent by construction. The call carries links to whatever it produced,
 * so running it twice returns the same records instead of making a second set.
 * That matters because the button is on screen and people press things twice.
 */

export type ProcessResult = {
  error?: string;
  contactId?: string;
  dealId?: string;
  meetingId?: string;
  /** A new person was added to the CRM. */
  contactCreated?: boolean;
  /** An existing person was recognised — a repeat caller, not a duplicate. */
  contactMatched?: boolean;
  meetingCreated?: boolean;
  /** The call itself, so the screen can name the caller in its confirmation. */
  call?: { id: string; callerName: string };
};

/**
 * The comparable part of a phone number.
 *
 * Digits alone are not enough: `0825514470` and `+27 82 551 4470` are the same
 * South African number, but one starts `0` and the other `27`, so an exact
 * digit comparison never matches a number saved locally against the same
 * number arriving from the network in international form. That is the ordinary
 * case for a repeat caller, and it silently produced a duplicate contact every
 * time — caught by a mutation whose test only passed because the caller's name
 * matched as well.
 *
 * The last nine digits are the national significant number nearly everywhere,
 * which is enough to identify a caller within one customer's contacts. It is a
 * deliberate trade: two numbers in different countries sharing nine trailing
 * digits would collide, which is vanishingly unlikely inside a single
 * sub-account and far less costly than duplicating everybody who calls twice.
 */
function phoneKey(s: string): string {
  const d = s.replace(/\D/g, "");
  return d.length > 9 ? d.slice(-9) : d;
}

/**
 * Find the caller among the contacts already on file.
 *
 * Phone first, because on a call it is the identifier — the caller said their
 * name out loud and somebody typed it, so the spelling is a guess, while the
 * number came from the network. Falls back to an exact, unambiguous name.
 */
async function findCaller(
  q: TenantQuery,
  phone: string | null,
  name: string
): Promise<string | null> {
  const contacts = await listContacts(q);

  const wantedPhone = phoneKey(phone ?? "");
  if (wantedPhone.length >= 7) {
    const byPhone = contacts.filter((c) => phoneKey(c.phone ?? "") === wantedPhone);
    if (byPhone.length === 1) return byPhone[0].id;
    // More than one contact on the same number is itself a duplicate; picking
    // between them would be a guess.
    if (byPhone.length > 1) return null;
  }

  const wanted = name.trim().toLowerCase().replace(/\s+/g, " ");
  if (!wanted) return null;
  const byName = contacts.filter(
    (c) => `${c.firstName} ${c.lastName}`.trim().toLowerCase() === wanted
  );
  return byName.length === 1 ? byName[0].id : null;
}

export async function processCall(q: TenantQuery, callId: string): Promise<ProcessResult> {
  const call = await getCall(q, callId);
  if (!call) return { error: "That call no longer exists." };

  // Already processed: hand back what it produced rather than producing more.
  if (call.createdDealId || call.createdMeetingId) {
    return {
      contactId: call.contactId ?? undefined,
      dealId: call.createdDealId ?? undefined,
      meetingId: call.createdMeetingId ?? undefined,
      // Nothing was created this time, and saying otherwise would claim work
      // that already happened.
      contactMatched: true,
      call: { id: call.id, callerName: call.callerName },
    };
  }

  // Somebody who said they were not interested is not an opportunity, and
  // recording one anyway inflates the pipeline with work nobody will do.
  if (call.outcome === "not-interested") {
    return { error: "Not interested — nothing to create." };
  }

  const name = call.callerName.trim();
  if (!name) return { error: "That call has no caller name to work from." };

  let contactId = call.contactId ?? (await findCaller(q, call.phone, name));
  const contactMatched = contactId !== null;

  if (!contactId) {
    const parts = name.split(/\s+/);
    const contact = await createContact(q, {
      firstName: parts[0] ?? name,
      lastName: parts.slice(1).join(" "),
      phone: call.phone,
      ownerUserId: q.ctx.userId,
    });
    contactId = contact.id;
  }

  // The opportunity. A caller who reached a human and did not refuse IS a
  // lead — which under this schema means a contact with an open deal, so the
  // deal is the thing that records it.
  const deal = await createDeal(q, {
    title: call.topic?.trim() || `Enquiry from ${name}`,
    contactId,
    // Attribution is a column, so a deal that came from the phone says so and
    // survives the caller being renamed later.
    source: "phone_call",
    stage: call.outcome === "meeting-booked" ? "discovery" : "prospect",
    ownerUserId: q.ctx.userId,
  });

  let meetingId: string | undefined;
  if (call.outcome === "meeting-booked" && call.requestedAt) {
    const meeting = await createMeeting(q, {
      contactId,
      dealId: deal.id,
      topic: call.topic?.trim() || "Call follow-up",
      // The instant resolved when the call was captured. The old model kept
      // "Tomorrow" as a label, which was only true on the day it was written.
      scheduledAt: call.requestedAt,
      kind: "online",
      ownerUserId: q.ctx.userId,
    });
    meetingId = meeting.id;
  }

  await linkCall(q, callId, { contactId, createdDealId: deal.id, createdMeetingId: meetingId ?? null });

  await logActivity(q, {
    entityType: "contact",
    entityId: contactId,
    kind: "call",
    title: contactMatched ? "Call handled by the voice agent" : "Created from a call",
    detail: call.summary ?? undefined,
    actorUserId: q.ctx.userId,
  });

  return {
    contactId,
    dealId: deal.id,
    meetingId,
    contactCreated: !contactMatched,
    contactMatched,
    meetingCreated: meetingId !== undefined,
    call: { id: call.id, callerName: call.callerName },
  };
}
