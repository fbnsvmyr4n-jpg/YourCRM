/**
 * A delivery, as a screen reads it.
 *
 * Declared here rather than beside the query that loads it: the card that
 * renders one is a client component, and `repos/goods-received` imports
 * `node:crypto`. A client component importing from `repos/*` drags that into
 * the browser bundle — it type-checks, it builds, and the page renders blank.
 * Twice now, which is why shared inert things live in `src/data/`.
 */
export type ReceivedLine = {
  id: string;
  priceItemId: string;
  itemName: string;
  unit: string;
  quantity: number;
};

export type GoodsReceived = {
  id: string;
  supplierId: string;
  supplierName: string;
  /** THEIR delivery-note number, for matching the supplier's invoice later. */
  reference: string | null;
  receivedOn: string;
  note: string | null;
  receivedByName: string | null;
  createdAt: string;
  lines: ReceivedLine[];
};
