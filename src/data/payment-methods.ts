/**
 * How money arrived, when it did not arrive through the card provider.
 *
 * Its own module, and not a constant beside `recordManualPayment` where it
 * started, because the form that offers these choices runs in the BROWSER. A
 * client component importing it from `repos/payments` pulls that whole file in
 * with it — and that file imports `node:crypto`, which webpack cannot bundle
 * for a browser. The page did not fail to type-check or to build; it failed at
 * run time with "Reading from node:crypto is not handled", and the screen was
 * blank.
 *
 * So the list lives where both sides may read it: no imports, no secrets, no
 * database. The same reasoning as `data/vocabulary.ts` and its type-only
 * import — what crosses between server and client has to be inert.
 */

export const PAYMENT_METHODS = ["transfer", "cash", "card machine", "cheque", "other"] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
