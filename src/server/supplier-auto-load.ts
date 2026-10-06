import { planChanges, unattendedVerdict } from "./price-import";
import { businessToday } from "./repos/settings";
import {
  applyPriceList,
  listSuppliers,
  loadForMessage,
  recordLoad,
  supplierItems,
  type ApplyResult,
} from "./repos/suppliers";
import { findSupplierList, type MailLike } from "./supplier-mail";
import type { TenantQuery } from "./tenant";

/**
 * Loading a supplier's emailed list without anybody pressing anything.
 *
 * Slice 2b, and the last word in note 17's middle act: "have a feature to
 * automatically update the price lists once that data has been emailed
 * through". Slice 2 made the message RECOGNISABLE and still asked a person to
 * look. This is the switch that lets a merchant you trust skip the looking —
 * for the lists where there is nothing to look at.
 *
 * ── Why this is not a switch that turns the safeguard off ─────────────────
 *
 * `supplier-mail.ts` argues that a recognised list must never write itself, and
 * that argument is right and still stands. What it is really about is the
 * LOOKING, so the question worth asking is what the looking is for. Three of
 * the four checks a person makes are already mechanical — is this a price list,
 * is it really from them, did every line parse — and the fourth, are these
 * numbers plausible, is mostly arithmetic against what is already on file.
 *
 * `unattendedVerdict` is that fourth check, written down. When it says no, this
 * does nothing at all and the message falls back to exactly today's behaviour:
 * the card, and a person who looks. A held list is not a refused list.
 *
 * ── Why it is deliberately quiet about doing nothing ──────────────────────
 *
 * Only a load is recorded. A supplier without the switch on, a message that is
 * not a list, a list held back — none of those write anything, because they are
 * the normal state of almost every message that arrives. A log of non-events is
 * a log nobody reads.
 */

export type AutoLoadOutcome =
  | { loaded: true; supplierName: string; result: ApplyResult }
  | { loaded: false; supplierName: string; because: string }
  | null;

/**
 * Try to load the list in a message that has just arrived.
 *
 * Returns null when there was nothing to do, which is almost always.
 *
 * MUST be called with a querier that holds the MONEY door, not the mail one.
 * Recognising a price list in an email is mail work; writing what the business
 * pays for stone is not, and running this inside the inbox's own transaction
 * would be the gate quietly widened by proximity. It is also why this is called
 * after the message is committed rather than alongside it — a view-only reader
 * logging a message would otherwise have the refused price write roll back the
 * message they actually meant to save.
 */
export async function autoLoadFromMessage(
  q: TenantQuery,
  message: MailLike & { id: string }
): Promise<AutoLoadOutcome> {
  const suppliers = await listSuppliers(q);
  const found = findSupplierList(message, suppliers);
  if (!found) return null;

  const supplier = suppliers.find((s) => s.id === found.supplierId);
  /* Not switched on is the default and the silent case. Nothing is recorded and
     nothing is said: the card in the inbox is already the right answer. */
  if (!supplier?.autoLoad) return null;

  /*
     ALREADY LOADED, ASKED BEFORE ANYTHING IS APPLIED.

     The unique index is what makes this safe under a race; this is what makes
     it cheap and correct under the ordinary case. Checked afterwards instead,
     a second call would re-apply the whole list and only then discover it had
     already been done — re-stamping the supplier's date, and writing a second
     set of updates for a list nobody sent twice.
  */
  if (await loadForMessage(q, message.id)) return null;

  const existing = await supplierItems(q, found.supplierId);
  const changes = planChanges(found.lines, existing);

  /* `found.unread` already excludes prose — the greeting and the sign-off are
     counted separately by `findSupplierList`, precisely so a polite email does
     not read as a list full of errors. What is left is rows that tried to be a
     price and failed, which is what should stop an unattended load. */
  const verdict = unattendedVerdict(changes, found.unread, existing.length);
  if (!verdict.load) {
    return { loaded: false, supplierName: supplier.name, because: verdict.because };
  }

  const result = await applyPriceList(q, found.supplierId, changes, await businessToday(q));

  /*
     Recorded with no user, which is the fact worth storing: nobody pressed
     anything. If the record cannot be written, the load is still real and the
     prices have moved — so this returns what happened rather than pretending it
     did not. The unique index means a second attempt on the same message writes
     nothing, which is how a re-render cannot load the same list twice.
  */
  await recordLoad(q, {
    supplierId: found.supplierId,
    messageId: message.id,
    userId: null,
    result,
  });

  return { loaded: true, supplierName: supplier.name, result };
}
