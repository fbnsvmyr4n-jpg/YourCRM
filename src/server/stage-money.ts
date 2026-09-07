import type { DocumentKind, DocumentStatus, ProjectDocument } from "./repos/projects";

/**
 * What each stage of a job was charged for, and what it has cost.
 *
 * The project header has answered this for the whole job since the projects
 * screen was built: quoted minus committed is the margin, derived from the
 * documents so it cannot go stale. What it could not answer was WHERE the
 * margin went, because nothing said which stage a document line belonged to.
 *
 * Now a line can point at a task, so the same arithmetic runs per stage. That
 * is the number a person actually acts on: a job at 22% overall tells you to
 * worry, and a job whose steel erection is at −4% tells you what to do.
 *
 * Pure, and given documents rather than a database, because the rules about
 * WHICH documents count are the part worth checking by hand — and they are the
 * same rules the header already uses. Two definitions of "committed" on one
 * screen would be worse than none.
 */

export type StageMoney = {
  /** Charged to the client: quote lines on this stage that were accepted. */
  quotedCents: number;
  /** Owed to suppliers: purchase-order lines on this stage still live. */
  committedCents: number;
  /** What is left. Negative means this stage is being done at a loss. */
  marginCents: number;
  /** How many documents touch this stage at all, whatever their status. */
  documents: number;
};

/**
 * A quote counts once the client has agreed to it.
 *
 * `accepted` and `paid` only — deliberately the same test the project header
 * uses. A quotation that has merely been sent is a hope, and a margin built on
 * hopes reads as fact on a screen next to real numbers.
 */
export function quoteCounts(status: DocumentStatus): boolean {
  return status === "accepted" || status === "paid";
}

/**
 * A purchase order counts unless it was called off.
 *
 * The opposite default to a quotation, and the asymmetry is the point: money
 * we might receive should be certain before it is counted, money we might owe
 * should be counted before it is certain. A draft PO is a commitment somebody
 * has decided to make, and leaving it out until it is sent would make a stage
 * look profitable right up to the moment it is not.
 */
export function orderCounts(status: DocumentStatus): boolean {
  return status !== "cancelled" && status !== "declined";
}

const counts = (kind: DocumentKind, status: DocumentStatus): "quote" | "order" | null => {
  if (kind === "quote") return quoteCounts(status) ? "quote" : null;
  if (kind === "purchase_order") return orderCounts(status) ? "order" : null;
  /* Invoices are excluded from both sides. An invoice is the same money as its
     quotation seen later; counting it would double what the client was
     charged. It still appears in a stage's document list — it is paperwork
     about that work — it simply does not move the arithmetic. */
  return null;
};

/** Every stage's money, keyed by task id. Stages with nothing filed are absent. */
export function stageMoney(documents: readonly ProjectDocument[]): Map<string, StageMoney> {
  const out = new Map<string, StageMoney>();
  const seen = new Map<string, Set<string>>();

  for (const doc of documents) {
    const side = counts(doc.kind, doc.status);
    for (const line of doc.lines) {
      const taskId = line.projectTaskId;
      if (!taskId) continue;

      const entry =
        out.get(taskId) ?? { quotedCents: 0, committedCents: 0, marginCents: 0, documents: 0 };

      /* Counted once per document, not once per line: a purchase order with
         three lines against one stage is one piece of paperwork. */
      const docs = seen.get(taskId) ?? new Set<string>();
      docs.add(doc.id);
      seen.set(taskId, docs);

      if (side === "quote") entry.quotedCents += line.totalCents;
      if (side === "order") entry.committedCents += line.totalCents;

      out.set(taskId, entry);
    }
  }

  for (const [taskId, entry] of out) {
    entry.marginCents = entry.quotedCents - entry.committedCents;
    entry.documents = seen.get(taskId)?.size ?? 0;
  }
  return out;
}

/**
 * The documents that touch a stage, and which of their lines do.
 *
 * A document belongs to the stages its lines point at — derived, never stored,
 * so it cannot disagree with the lines themselves. A quotation covering five
 * stages appears under all five, showing only the line that belongs to each.
 */
export function documentsForStage(
  documents: readonly ProjectDocument[],
  taskId: string
): { document: ProjectDocument; lines: ProjectDocument["lines"] }[] {
  const out: { document: ProjectDocument; lines: ProjectDocument["lines"] }[] = [];
  for (const document of documents) {
    const lines = document.lines.filter((l) => l.projectTaskId === taskId);
    if (lines.length > 0) out.push({ document, lines });
  }
  return out;
}

/** Lines filed against no stage at all, so the Documents tab can say so. */
export function unfiledLineCount(documents: readonly ProjectDocument[]): number {
  return documents.reduce(
    (n, d) => n + d.lines.filter((l) => !l.projectTaskId).length,
    0
  );
}
