import type { AvatarColor } from "@/components/ui/Avatar";
import { deals as seed, FALLBACK_STAGE, STAGE_IDS, type Deal, type StageId } from "@/data/deals";
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
  const value = Number.isFinite(deal.value) ? Math.max(0, deal.value) : 0;

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
      value: Number.isFinite(input.value) ? Math.max(0, Math.round(input.value)) : 0,
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
    // Record when the deal actually reached "won", so revenue reporting is
    // driven by a real event. Moving it back out clears the stamp — otherwise
    // a deal that was reopened would keep counting as revenue. Re-winning a
    // deal that is already won must not reset the original date.
    const wonAt =
      stage === "won" ? (current.wonAt ?? new Date().toISOString()) : undefined;

    const next = [...rows];
    next[idx] = { ...current, stage, wonAt };
    return next;
  });
}

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
