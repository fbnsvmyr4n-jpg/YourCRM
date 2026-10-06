import {
  parsePriceList,
  planChanges,
  unattendedVerdict,
  type ExistingItem,
  type ParsedLine,
} from "./price-import";

/**
 * Recognising a supplier's price list in a message that arrived.
 *
 * Slice 2 of what Bradley asked for: "have a feature to automatically update
 * the price lists once that data has been emailed through". The merchant emails
 * their new sheet; nobody should have to notice it, open it, select it, and
 * paste it into another screen.
 *
 * ── What this deliberately does NOT do ────────────────────────────────────
 *
 * It does not apply anything. It recognises, and the one press that follows
 * goes through the same preview a paste does.
 *
 * That is a real decision and worth stating plainly, because "automatically
 * update" could be read as "write it straight in". Every quotation this
 * business sends is built from these numbers, and a message is a thing anyone
 * on the internet can send: an address can be spoofed, a supplier's own system
 * can send a draft tariff, a quote for one job reads exactly like a price list
 * for all of them. Writing prices nobody looked at, triggered by mail nobody
 * asked for, is the one failure that would quietly cost real money on every
 * job afterwards. So the automation removes the TYPING, which is the part that
 * was actually costing time, and leaves the looking — which takes five seconds
 * and is the whole safeguard.
 *
 * Pure, like the parser it builds on: no database, no tenant. It is handed the
 * message and the suppliers and returns what it thinks.
 */

/** Just enough of a message to recognise one. */
export type MailLike = {
  direction: "sent" | "received";
  email: string;
  subject: string;
  body: string[];
};

/** Just enough of a supplier to match against. */
export type SupplierLike = {
  id: string;
  name: string;
  email: string | null;
  /**
   * Whether their lists load themselves, and what they currently price.
   *
   * Both optional, because most callers of `findSupplierList` only want to know
   * WHOSE list this is. They are carried for the one that also has to explain
   * why a list was held back — see `heldBecause` below, and `unattendedVerdict`.
   */
  autoLoad?: boolean;
  items?: ExistingItem[];
};

export type SupplierListInMail = {
  supplierId: string;
  supplierName: string;
  /** The text to load, which is the message body as it stands. */
  text: string;
  /** What the parser already made of it, so the screen can say how many. */
  lines: ParsedLine[];
  /**
   * Lines that carried no price at all — a greeting, a sign-off, "Regards".
   *
   * Kept apart from the ones below on purpose. A pasted table is meant to be
   * all prices, so anything unread there is a miss worth staring at. An EMAIL
   * always has prose around the table, and calling "Morning — our new rates
   * from the 1st" a line we could not read would put an alarming number on
   * every single supplier message. Noise on every message is how a warning
   * stops being read, and this warning is the safeguard.
   */
  prose: number;
  /** Lines that looked like prices and could not be trusted. These matter. */
  unread: number;
  /** Why this was offered, said in the reader's words. */
  because: string;
  /**
   * Why it was NOT loaded on its own, for a supplier whose lists otherwise are.
   *
   * Null when the switch is off — there is nothing to explain, because nothing
   * was expected — and null when it would have loaded.
   *
   * Said rather than left to be wondered about. Somebody who has turned the
   * switch on and is looking at a "Review and load it" button has one question,
   * and "Site labour went up by 89%" both answers it and points them straight
   * at the line worth staring at. Silence here would make the feature look
   * arbitrary, and a safeguard nobody understands is one they switch off.
   */
  heldBecause: string | null;
};

/**
 * Words a supplier puts in the subject when they send one.
 *
 * Only ever used to RAISE confidence, never on its own — a message is matched
 * because of who sent it and what is in it, and a subject line is neither.
 */
const SUBJECT_HINT = /\b(price|prices|pricing|rate|rates|tariff|list|catalogue|catalog|quote list)\b/i;

/** The address, lowercased and trimmed, or null. */
const addr = (value: string | null | undefined) => value?.trim().toLowerCase() || null;

/**
 * How many priced rows make a message a price LIST rather than a sentence.
 *
 * Three. One or two numbers in an email is somebody quoting a job — "the stone
 * is 480 and delivery is 300" — and offering to load that as their whole price
 * list would put two rows in and look like it had worked. Three in a row that
 * all parse as name/unit/price is a table, and a table is a list.
 */
const ENOUGH_ROWS = 3;

/**
 * Does this message carry a price list, and whose?
 *
 * Returns null far more often than not, and that is the point: the card this
 * drives appears on a supplier's price sheet and on nothing else. A reader who
 * sees it on an ordinary email stops believing it on the real one.
 */
export function findSupplierList(
  mail: MailLike,
  suppliers: SupplierLike[]
): SupplierListInMail | null {
  /* Only mail that came IN. Our own message to a supplier quoting their own
     rates back at them is not their price list. */
  if (mail.direction !== "received") return null;

  const from = addr(mail.email);
  if (!from) return null;

  /*
     Matched on the ADDRESS, never on the name.

     A supplier called "Stone Yard" and a message from somebody whose display
     name happens to contain those words are not the same fact, and the whole
     safety of this rests on being sure whose list it is. The address is what
     was typed into the supplier's record precisely so this could be certain.
  */
  const supplier = suppliers.find((s) => addr(s.email) === from);
  if (!supplier) return null;

  const text = mail.body.join("\n");
  if (!text.trim()) return null;

  const { lines, unread } = parsePriceList(text);
  if (lines.length < ENOUGH_ROWS) return null;

  /* "no price on this line" in an email is prose. Every other reason — a zero,
     a price with nothing named against it — is a row that tried to be a price
     and failed, which is the kind worth showing. */
  const prose = unread.filter((u) => u.reason === "no price on this line").length;

  const hinted = SUBJECT_HINT.test(mail.subject);

  /*
     Computed with the SAME pure function the server loads by, rather than a
     second rule that agrees with it today. Both run `unattendedVerdict`; if
     they could disagree, the screen would eventually explain a decision that
     was not the one taken.
  */
  const verdict =
    supplier.autoLoad && supplier.items
      ? unattendedVerdict(
          planChanges(lines, supplier.items),
          unread.length - prose,
          supplier.items.length
        )
      : null;

  return {
    supplierId: supplier.id,
    supplierName: supplier.name,
    text,
    lines,
    prose,
    unread: unread.length - prose,
    /* Said as the reason it is being offered, because a reader deciding
       whether to trust it needs to know what was actually matched. */
    because: hinted
      ? `From ${supplier.name}, and the subject mentions prices`
      : `From ${supplier.name}`,
    heldBecause: verdict && !verdict.load ? verdict.because : null,
  };
}
