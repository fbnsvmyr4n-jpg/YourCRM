import type { AvatarColor } from "@/components/ui/Avatar";
import {
  carriesMoney,
  deals as seed,
  FALLBACK_STAGE,
  STAGE_IDS,
  type Deal,
  type StageId,
} from "@/data/deals";
import { mutateTable, readTable } from "./store";

const TABLE = "deals";

const COLORS: AvatarColor[] = ["blue", "green", "amber", "purple", "pink", "teal"];

export type NewDeal = {
  title: string;
  contact: string;
  company: string;
  value: number;
  stage: StageId;
};

function initialsFor(name: string) {
  const parts = name.trim().split(/\s+/);
  const a = parts[0]?.[0] ?? "";
  const b = parts[1]?.[0] ?? "";
  return (a + b || name.trim().slice(0, 2)).toUpperCase();
}

function slugId(title: string) {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return `deal-${base || "new"}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Defence in depth for rows that are already stored.
 *
 * Validation at the action boundary stops *new* bad data, but a deal written
 * before that existed — or by any future path that skips it — must not be able
 * to break the board. A deal whose stage isn't a real stage renders in no
 * column at all: invisible, undeletable, yet still counted in every total. A
 * non-numeric value turns Weighted Forecast into "$NaN".
 *
 * So reads normalise instead of trusting the stored shape: an unknown stage
 * surfaces in the first column where it can be seen and moved, and a broken
 * value reads as 0. Nothing is silently dropped.
 */
function normalise(deal: Deal): Deal {
  const stage = (STAGE_IDS as readonly string[]).includes(deal.stage)
    ? deal.stage
    : FALLBACK_STAGE;

  // Leads In and Qualified carry no money — enforced on read as well as write,
  // so figures stored before that rule existed (or by any path that skips
  // validation) can't leak into a total that is presented as a measurement.
  const raw = Number.isFinite(deal.value) ? Math.max(0, deal.value) : 0;
  const value = carriesMoney(stage) ? raw : 0;

  // Backfill for deals won before `wonAt` existed. Rows already in the store
  // don't gain a new field, so without this every historical win silently
  // stops counting as revenue. `closeDate` is a date the user actually
  // recorded, so using it is reporting what's there, not inventing it — and
  // when it isn't a real date ("—"), the deal genuinely has no date and stays
  // out of the time series. Read-side only: nothing is rewritten on disk.
  const wonAt = deal.wonAt ?? (stage === "won" ? parseCloseDate(deal.closeDate) : undefined);

  if (stage === deal.stage && value === deal.value && wonAt === deal.wonAt) return deal;
  return { ...deal, stage, value, wonAt };
}

/** "18 Jul 2026" → ISO. Undefined when the field isn't a real date. */
function parseCloseDate(closeDate: string): string | undefined {
  const t = Date.parse(closeDate);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

export async function listDeals(): Promise<Deal[]> {
  const rows = await readTable<Deal>(TABLE, seed);
  return rows.map(normalise);
}

export async function createDeal(input: NewDeal): Promise<Deal> {
  let deal!: Deal;
  await mutateTable<Deal>(TABLE, seed, (rows) => {
    const contact = input.contact.trim() || "New Contact";
    deal = {
      id: slugId(input.title),
      title: input.title.trim() || "Untitled Deal",
      contact,
      company: input.company.trim() || "—",
      initials: initialsFor(contact),
      color: COLORS[rows.length % COLORS.length],
      // A deal added to Leads In or Qualified carries no figure, whatever the
      // form sent — those stages are before any quote exists.
      value: carriesMoney(input.stage) && Number.isFinite(input.value)
        ? Math.max(0, Math.round(input.value))
        : 0,
      stage: input.stage,
      owner: "Lang Lee",
      closeDate: "—",
      // A deal added straight into "Closed Won" is won as of now.
      wonAt: input.stage === "won" ? new Date().toISOString() : undefined,
    };
    return [deal, ...rows];
  });
  return deal;
}

export async function moveDeal(id: string, stage: StageId): Promise<void> {
  await mutateTable<Deal>(TABLE, seed, (rows) => {
    const idx = rows.findIndex((d) => d.id === id);
    if (idx === -1) return rows;

    const current = rows[idx];

    // Dragging the outstanding remainder into Closed Won settles the deal:
    // merge it back into the record holding the part already paid, so the
    // board shows one entry at the full contract value rather than two
    // fragments the user has to add up themselves.
    if (stage === "won" && current.splitId) {
      const sibling = rows.find(
        (d) => d.id !== current.id && d.splitId === current.splitId && d.stage === "won"
      );
      if (sibling) {
        return rows
          .filter((d) => d.id !== current.id)
          .map((d) =>
            d.id === sibling.id
              ? { ...d, value: d.value + current.value, wonAt: d.wonAt ?? new Date().toISOString() }
              : d
          );
      }
    }

    // Record when the deal actually reached "won", so revenue reporting is
    // driven by a real event. Moving it back out clears the stamp — otherwise
    // a deal that was reopened would keep counting as revenue. Re-winning a
    // deal that is already won must not reset the original date.
    const wonAt =
      stage === "won" ? (current.wonAt ?? new Date().toISOString()) : undefined;

    // `mutateTable` hands back raw stored rows, not normalised ones — so a lead
    // written before Leads In carried no money still holds its old figure on
    // disk, invisible on the board but very much there. Promoting it must not
    // resurrect a number nobody quoted, so a value only survives a move
    // *between* money stages; arriving from Leads In or Qualified starts blank
    // and the user enters the quote.
    const cameFromMoney = carriesMoney(
      (STAGE_IDS as readonly string[]).includes(current.stage) ? current.stage : FALLBACK_STAGE
    );
    const value = carriesMoney(stage) && cameFromMoney ? current.value : 0;

    const next = [...rows];
    next[idx] = { ...current, stage, value, wonAt };
    return next;
  });
}

/**
 * Set a deal's value.
 *
 * Needed because a deal arriving in Proposals from Qualified has no figure yet
 * — Qualified carries no money, so the number is entered at the point a quote
 * actually exists.
 */
export async function setDealValue(id: string, value: number): Promise<void> {
  await mutateTable<Deal>(TABLE, seed, (rows) => {
    const idx = rows.findIndex((d) => d.id === id);
    if (idx === -1) return rows;

    const current = rows[idx];
    if (!carriesMoney(current.stage)) return rows;

    const next = [...rows];
    next[idx] = {
      ...current,
      value: Math.max(0, Math.round(value)),
      // Re-quoting a deal that was never split resets nothing; one that *was*
      // split keeps its original total so the paid/outstanding split stays
      // meaningful.
      splitTotal: current.splitId ? current.splitTotal : undefined,
    };
    return next;
  });
}

export type PaymentResult = { error?: string };

/**
 * Record a payment against a deal awaiting settlement.
 *
 * Splits it in two: what has been received moves to Closed Won, what is still
 * owed stays in Negotiations. Paying the full outstanding amount settles it
 * outright — there is no zero-value remainder left behind.
 *
 * All of it happens inside one `mutateTable`, because the two halves must never
 * exist independently: a crash between "reduce the remainder" and "create the
 * paid record" would destroy money.
 */
export async function recordPayment(id: string, amount: number): Promise<PaymentResult> {
  let error: string | undefined;

  await mutateTable<Deal>(TABLE, seed, (rows) => {
    const idx = rows.findIndex((d) => d.id === id);
    if (idx === -1) {
      error = "Deal not found.";
      return rows;
    }

    const deal = rows[idx];
    if (deal.stage !== "negotiation") {
      error = "Payments can only be recorded against a deal in Negotiations.";
      return rows;
    }

    const paid = Math.round(amount);
    if (!Number.isFinite(paid) || paid <= 0) {
      error = "Enter an amount greater than zero.";
      return rows;
    }
    if (paid > deal.value) {
      error = `That is more than the ${fmt(deal.value)} still outstanding.`;
      return rows;
    }

    const splitId = deal.splitId ?? `split-${Math.random().toString(36).slice(2, 10)}`;
    // Captured once, at the first split — the full contract value is what
    // decides whether the won record is partially or fully paid.
    const splitTotal = deal.splitTotal ?? deal.value;
    const remaining = deal.value - paid;

    const existingWon = rows.find((d) => d.splitId === splitId && d.stage === "won");

    let next = rows.map((d) => {
      if (d.id !== deal.id) return d;
      return { ...d, value: remaining, splitId, splitTotal };
    });

    if (existingWon) {
      // A second part-payment tops up the same won record rather than
      // scattering the deal across several cards.
      next = next.map((d) =>
        d.id === existingWon.id ? { ...d, value: d.value + paid, splitTotal } : d
      );
    } else {
      const settled: Deal = {
        ...deal,
        id: `${deal.id}-paid-${Math.random().toString(36).slice(2, 6)}`,
        value: paid,
        stage: "won",
        splitId,
        splitTotal,
        wonAt: new Date().toISOString(),
      };
      next = [settled, ...next];
    }

    // Nothing left owing: drop the empty remainder so the board doesn't show a
    // $0 card sitting in Negotiations.
    if (remaining === 0) next = next.filter((d) => d.id !== deal.id);

    return next;
  });

  return { error };
}

const fmt = (n: number) => `$${n.toLocaleString()}`;

export async function deleteDeal(id: string): Promise<void> {
  await mutateTable<Deal>(TABLE, seed, (rows) => rows.filter((d) => d.id !== id));
}

/* ---------------- revenue ---------------- */

/**
 * Deals that have genuinely been won, newest first.
 *
 * Requires *both* the stage and the timestamp: a row normalised out of an
 * unknown stage could otherwise still carry a stale `wonAt` and be counted as
 * revenue it never earned.
 */
export async function listWonDeals(): Promise<(Deal & { wonAt: string })[]> {
  const rows = await listDeals();
  return rows
    .filter((d): d is Deal & { wonAt: string } => d.stage === "won" && !!d.wonAt)
    .sort((a, b) => b.wonAt.localeCompare(a.wonAt));
}

/**
 * Real revenue bucketed by week, oldest first — what the dashboard chart plots.
 *
 * Weeks with no wins are included as zero rather than skipped, so the gaps are
 * visible and the x-axis stays evenly spaced. Early on this is mostly flat;
 * that is the honest shape of the data, and it fills in as deals close.
 */
export async function weeklyRevenue(weeks = 6): Promise<{ label: string; value: number }[]> {
  const won = await listWonDeals();

  // Week buckets ending today, walking backwards in 7-day steps.
  const now = new Date();
  const endOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + 86_400_000;
  const WEEK = 7 * 86_400_000;

  return Array.from({ length: weeks }, (_, i) => {
    const end = endOfToday - (weeks - 1 - i) * WEEK;
    const start = end - WEEK;
    const value = won
      .filter((d) => {
        const t = Date.parse(d.wonAt);
        return Number.isFinite(t) && t >= start && t < end;
      })
      .reduce((sum, d) => sum + d.value, 0);

    const label = new Date(end - 86_400_000).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
    return { label, value };
  });
}
