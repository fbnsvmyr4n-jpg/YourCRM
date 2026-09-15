import { withSystem, withTenant, type TenantContext } from "../tenant";
import { resolveSlug, type PublicLink } from "../repos/booking-links";
import { createContact, getContact, updateContact } from "../repos/contacts";
import { createDeal } from "../repos/deals";
import { logActivity } from "../repos/activity";
import { linkContactByName } from "../link-contact";
import { logWrite } from "../log";

/**
 * An enquiry from a stranger, straight onto the Leads screen.
 *
 * It lands exactly the way a phone enquiry does — a deal at `prospect` with a
 * real source — so the sales board, the Leads screen, the source breakdown and
 * the notification feed all pick it up without a second path for "web leads".
 * The message itself is kept as a note on the contact, in the person's own
 * words, because that is what somebody reads before they pick up the phone.
 *
 * Like the booking page, every step assumes the request is hostile:
 *
 *   1. The slug is resolved through the one unscoped read, for the ENQUIRY
 *      purpose — a link published only for bookings is not an enquiry form.
 *   2. The inputs are bounded and checked before anything is written.
 *   3. A hidden trap field catches the simplest bots. A filled trap is told
 *      "thanks" and nothing is written: saying no would teach the bot which
 *      field to leave alone.
 *   4. A second send from the same person within half an hour adds a note to
 *      the lead they already have, instead of opening another one. Double
 *      presses and "I forgot to say" are the common case, and a board with the
 *      same person on it twice is somebody's afternoon.
 *
 * Rate limiting happens above this, in the route, because it needs the caller's
 * address and should refuse before any of this runs.
 */

export type EnquiryRequest = {
  slug: string;
  name: string;
  email: string;
  phone?: string | null;
  message: string;
  /** The hidden field. A person never sees it, so a person never fills it. */
  trap?: string | null;
};

export type EnquiryOutcome =
  | { ok: true; workspaceName: string }
  | { ok: false; reason: "not_found" | "invalid"; detail: string };

const MAX_NAME = 80;
const MAX_EMAIL = 160;
const MAX_PHONE = 40;
const MAX_MESSAGE = 2000;
/** How long a second enquiry from the same person counts as the same enquiry. */
export const SAME_ENQUIRY_MINUTES = 30;

const oneLine = (value: unknown, max: number): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

/* A message keeps its line breaks — people write paragraphs — but not a wall
   of blank lines, and not more than a message's worth of text. */
const paragraphs = (value: unknown, max: number): string =>
  typeof value === "string"
    ? value
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, max)
    : "";

function validEmail(value: unknown): string | null {
  const text = oneLine(value, MAX_EMAIL).toLowerCase();
  return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(text) ? text : null;
}

/** Digits with the punctuation phone numbers are written with. Nothing else. */
function validPhone(value: unknown): string | null | "bad" {
  const text = oneLine(value, MAX_PHONE);
  if (!text) return null;
  return /^[+()\d][+()\d\s-]{4,}$/.test(text) && /\d{5,}/.test(text.replace(/\D/g, "")) ? text : "bad";
}

/** The first line of what they wrote, short enough to be a lead's title. */
function gist(message: string): string {
  const first = message.split("\n")[0].trim();
  return first.length > 60 ? `${first.slice(0, 57).trimEnd()}…` : first;
}

export async function enquire(request: EnquiryRequest): Promise<EnquiryOutcome> {
  const name = oneLine(request.name, MAX_NAME);
  const email = validEmail(request.email);
  const phone = validPhone(request.phone);
  const message = paragraphs(request.message, MAX_MESSAGE);

  if (!name) return { ok: false, reason: "invalid", detail: "Please give your name." };
  if (!email) return { ok: false, reason: "invalid", detail: "Please give a valid email address." };
  if (phone === "bad") {
    return { ok: false, reason: "invalid", detail: "That phone number does not look right. Leave it blank if you prefer." };
  }
  if (!message) return { ok: false, reason: "invalid", detail: "Please tell us what you need." };

  /* The one unscoped read, for this purpose only. */
  const link: PublicLink | null = await withSystem((sys) => resolveSlug(sys, request.slug, "enquiry"));
  if (!link) {
    return { ok: false, reason: "not_found", detail: "That enquiry form is not available." };
  }

  /* The trap, answered like a success and acted on like nothing. Checked after
     the slug so a bot cannot use it to tell a live form from a dead one. */
  if (oneLine(request.trap, 200)) {
    return { ok: true, workspaceName: link.workspaceName };
  }

  const ctx: TenantContext = {
    agencyId: link.agencyId,
    subAccountId: link.subAccountId,
    userId: link.ownerUserId,
    role: "owner",
  };

  return withTenant(ctx, async (q) => {
    /* Matched by email where one exists. Where the match is ambiguous —
       two contacts already share this address, or this name — a new contact
       is created rather than guessing: a duplicate is visible and fixable, a
       wrong merge is neither. */
    const contactId =
      (await linkContactByName(q, name, email)) ??
      (
        await createContact(q, {
          firstName: name.split(" ")[0] ?? name,
          lastName: name.split(" ").slice(1).join(" "),
          email,
          ownerUserId: link.ownerUserId,
        })
      ).id;

    /* A phone number is added to a contact that has none. One that already has
       a different number keeps it — an enquiry form is not the place to
       overwrite what somebody in the office entered — and the new number goes
       in the note, so nothing they gave us is lost. */
    let phoneForNote: string | null = null;
    if (phone) {
      const contact = await getContact(q, contactId);
      if (contact && !contact.phone) {
        await updateContact(q, contactId, { phone });
      } else if (contact && contact.phone !== phone) {
        phoneForNote = phone;
      }
    }

    const existing = await q.one<{ id: string }>(
      `SELECT id FROM deals
        WHERE sub_account_id = $1 AND contact_id = $2
          AND stage = 'prospect' AND source = 'website' AND deleted_at IS NULL
          AND created_at > now() - ($3 || ' minutes')::interval
        ORDER BY created_at DESC
        LIMIT 1`,
      [q.ctx.subAccountId, contactId, String(SAME_ENQUIRY_MINUTES)]
    );

    let dealId = existing?.id ?? null;
    if (!dealId) {
      const deal = await createDeal(q, {
        title: `${name} — ${gist(message)}`,
        contactId,
        valueCents: 0,
        stage: "prospect",
        source: "website",
        ownerUserId: link.ownerUserId,
      });
      dealId = deal.id;
    }

    await logActivity(q, {
      entityType: "contact",
      entityId: contactId,
      kind: "note",
      title: existing ? "Website enquiry (follow-up)" : "Website enquiry",
      detail: phoneForNote ? `${message}\n\nPhone given: ${phoneForNote}` : message,
      actorUserId: null,
    });

    /* No name, no email, no message — a log line is not the place for a
       stranger's words. The lead id is enough to find the rest. */
    logWrite(existing ? "update" : "create", "enquiry", { id: dealId, actor: "public" });

    return { ok: true as const, workspaceName: link.workspaceName };
  });
}
