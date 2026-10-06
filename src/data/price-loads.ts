/**
 * One occasion on which a supplier's price list was applied.
 *
 * ── Why the type lives here and not beside the query that reads it ────────
 *
 * The card in the inbox is a client component, and `repos/suppliers` imports
 * `node:crypto` for its id generator. A client component that imports anything
 * from `repos/*` drags that into the browser bundle: it type-checks, it builds,
 * and the page renders blank at run time with an error nothing in the toolchain
 * warned about. That has now happened twice in this codebase, which is why
 * shared inert things live in `src/data/`.
 */
export type PriceListLoad = {
  id: string;
  supplierId: string;
  supplierName: string;
  messageId: string | null;
  /**
   * Who pressed it, or NULL for a list that loaded itself.
   *
   * The null is the point of the field. "Nobody pressed anything" is a
   * different fact from "we cannot remember who", and it is the first one
   * somebody checks when a quotation comes out wrong.
   */
  loadedByUserId: string | null;
  loadedByName: string | null;
  added: number;
  repriced: number;
  unchanged: number;
  loadedAt: string;
};
