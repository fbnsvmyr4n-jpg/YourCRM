/*
   Recognising a supplier's price list in a message that arrived.

   Slice 2 of note 17: "have a feature to automatically update the price lists
   once that data has been emailed through". The merchant emails their new
   sheet, and nobody should have to notice it, open it, select it and paste it
   into another screen.

   MOST OF THIS FILE IS ABOUT NOT OFFERING. The card this drives has to appear
   on a price sheet and on nothing else — a reader who sees it on an ordinary
   email stops believing it on the real one, and then the feature is worse than
   not having it. So the tests that matter are the ones where it stays quiet.
*/
import { describe, expect, it } from "vitest";
import { findSupplierList, type MailLike, type SupplierLike } from "@/server/supplier-mail";

const SUPPLIERS: SupplierLike[] = [
  { id: "sup-stone", name: "Stone Yard", email: "sales@stoneyard.test" },
  { id: "sup-timber", name: "Timber Co", email: null },
];

const LIST = [
  "Paving stone\tm²\t480.00",
  "Bedding sand\tm³\t320.00",
  "Site labour\tday\t1,800.00",
];

const mail = (over: Partial<MailLike> = {}): MailLike => ({
  direction: "received",
  email: "sales@stoneyard.test",
  subject: "Our October price list",
  body: LIST,
  ...over,
});

describe("a price list from a known supplier", () => {
  it("is recognised, and says whose and why", () => {
    const found = findSupplierList(mail(), SUPPLIERS);
    expect(found).toMatchObject({
      supplierId: "sup-stone",
      supplierName: "Stone Yard",
      because: "From Stone Yard, and the subject mentions prices",
    });
    expect(found?.lines).toHaveLength(3);
  });

  it("is still recognised when the subject says nothing useful", () => {
    /* The subject only ever raises confidence. Who sent it and what is in it
       are the facts; "FW: see attached" is neither. */
    const found = findSupplierList(mail({ subject: "FW: see attached" }), SUPPLIERS);
    expect(found).toMatchObject({ supplierId: "sup-stone", because: "From Stone Yard" });
  });

  it("TELLS PROSE APART FROM A ROW THAT FAILED", () => {
    /*
       A pasted table is meant to be all prices, so anything unread there is a
       miss worth staring at. An email always has a greeting and a sign-off
       around the table — calling those "lines we could not read" would put an
       alarming number on every single supplier message, and noise on every
       message is how a warning stops being read. This warning is the
       safeguard, so it has to stay quiet when nothing is wrong.
    */
    const found = findSupplierList(
      mail({
        body: [
          "Morning — our new rates from the 1st.",
          ...LIST,
          "Site visit\teach\t0.00",
          "Regards",
          "Stone Yard",
        ],
      }),
      SUPPLIERS
    );
    expect(found?.lines).toHaveLength(3);
    /* The zero tried to be a price and could not be trusted. */
    expect(found?.unread).toBe(1);
    /* The greeting and the two sign-off lines did not try. */
    expect(found?.prose).toBe(3);
  });
});

describe("what it refuses to offer", () => {
  it("says nothing about mail from somebody who is not a supplier", () => {
    expect(findSupplierList(mail({ email: "ben@cole.test" }), SUPPLIERS)).toBeNull();
  });

  it("MATCHES ON THE ADDRESS, never on the name", () => {
    /*
       The whole safety of this rests on being certain whose list it is. A
       message whose display name happens to say "Stone Yard" is not a fact
       about who sent it — the address in the supplier's record is, which is
       why that field exists.
    */
    expect(findSupplierList(mail({ email: "noreply@stone-yard-deals.test" }), SUPPLIERS)).toBeNull();
  });

  it("says nothing for a supplier with no address on file", () => {
    /* Timber Co has no email. Matching them on anything else would be a guess
       about where money comes from. */
    expect(findSupplierList(mail({ email: "hello@timberco.test" }), SUPPLIERS)).toBeNull();
  });

  it("ignores our own outgoing mail", () => {
    /* Quoting a supplier's own rates back at them is not their price list. */
    expect(findSupplierList(mail({ direction: "sent" }), SUPPLIERS)).toBeNull();
  });

  it("DOES NOT TREAT A SENTENCE WITH TWO NUMBERS IN IT AS A PRICE LIST", () => {
    /*
       The failure that would make this feature untrustworthy. "The stone is
       480 and delivery is 300" is somebody quoting one job. Offering to load
       it as Stone Yard's entire price list would put two rows in and look like
       it had worked.
    */
    const found = findSupplierList(
      mail({ body: ["Morning — the stone is 480 a square", "and delivery is 300 a load."] }),
      SUPPLIERS
    );
    expect(found).toBeNull();
  });

  it("says nothing about an empty message", () => {
    expect(findSupplierList(mail({ body: [] }), SUPPLIERS)).toBeNull();
    expect(findSupplierList(mail({ body: ["", "   "] }), SUPPLIERS)).toBeNull();
  });

  it("says nothing when the workspace has no suppliers at all", () => {
    expect(findSupplierList(mail(), [])).toBeNull();
  });

  it("is not fooled by case or spacing in the address", () => {
    expect(findSupplierList(mail({ email: "  Sales@StoneYard.test " }), SUPPLIERS)).toMatchObject({
      supplierId: "sup-stone",
    });
  });
});

describe("the line it draws at three rows", () => {
  it("offers three", () => {
    expect(findSupplierList(mail({ body: LIST }), SUPPLIERS)).not.toBeNull();
  });

  it("does not offer two", () => {
    expect(findSupplierList(mail({ body: LIST.slice(0, 2) }), SUPPLIERS)).toBeNull();
  });
});
