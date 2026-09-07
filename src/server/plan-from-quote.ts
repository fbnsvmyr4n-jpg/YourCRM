import { finishAfter, nextWorkingDay, type Holidays } from "./schedule";
import { addDependency, addTask, listTasks } from "./repos/tasks";
import { listPriceItems } from "./repos/pricing";
import { holidaySet } from "./repos/holidays";
import type { TenantQuery } from "./tenant";

/**
 * The schedule a quotation already implies.
 *
 * Adding a task takes five fields — a name, two dates, a percentage and an
 * owner — and a real job has fifteen of them. That is seventy-five inputs to
 * type a plan that, for the most part, is already written down: somebody
 * itemised the work when they quoted for it, a person approved those lines,
 * and a client accepted them. The Timeline was asking for all of it again.
 *
 * So this reads the quotation and lays the plan out. Not a guess about what
 * the job involves — the lines a human already committed to, in the order they
 * were written, chained end to end on working days.
 *
 * ── What is derived and what is admitted ─────────────────────────────────
 *
 * The NAME and the ORDER come straight from the quotation and are as reliable
 * as it is. The DURATION is an inference, and a weaker one: a quote line
 * records a quantity but not what the quantity counts, so "Mobile crane hire,
 * 3" is three days to a reader and three cranes to a database. The unit lives
 * on the price list, and a quote line does not reference the price item it came
 * from — only its text — so the unit is recovered by name where it can be and
 * assumed to be a single day where it cannot.
 *
 * That is stated on screen rather than hidden. A plan whose shape is right and
 * whose lengths need adjusting is worth far more than an empty page, but only
 * if nobody mistakes it for a considered estimate.
 */

/** A task the quotation implies, before anything is written down. */
export type PlannedTask = {
  name: string;
  /** Working days, always at least one. */
  workingDays: number;
  startsOn: string;
  dueOn: string;
  /** False when the length is the fallback rather than something the quote said. */
  durationKnown: boolean;
};

export type QuoteLine = { description: string; quantity: number };

/**
 * The longest a single inferred task may be.
 *
 * A quantity is not a duration and occasionally it is not even close — "Cable,
 * 2500" is metres. Without a ceiling one such line draws a bar ten years long
 * and every other task on the chart becomes a sliver. Capped rather than
 * discarded, because the task is real even when its length is nonsense.
 */
export const MAX_INFERRED_DAYS = 60;

/** Whether a price-list unit counts days. */
export function isDayUnit(unit: string | null | undefined): boolean {
  if (!unit) return false;
  return /(^|\s|\/)(per\s+)?days?(\s|$)/i.test(unit.trim());
}

/**
 * How long one line should run for.
 *
 * Only a day-based unit turns a quantity into a length. Everything else is one
 * day — a placeholder that says "this is a step in the job" without pretending
 * to know how long it takes. Fractions round UP: half a day of work still
 * occupies a day on a chart somebody plans around.
 */
export function daysForLine(quantity: number, unit: string | null | undefined): {
  workingDays: number;
  durationKnown: boolean;
} {
  if (!isDayUnit(unit)) return { workingDays: 1, durationKnown: false };
  if (!Number.isFinite(quantity) || quantity <= 0) return { workingDays: 1, durationKnown: false };
  return {
    workingDays: Math.min(Math.max(1, Math.ceil(quantity)), MAX_INFERRED_DAYS),
    durationKnown: true,
  };
}

/**
 * Lay the lines out end to end from a start date.
 *
 * Pure, and separate from every read and write around it, because this is the
 * part worth checking against dates worked out by hand — weekends, holidays,
 * a line that should not have become a task at all.
 *
 * Sequential rather than parallel on purpose. A quotation says what the work
 * is, never what can happen at once, and a plan that claims fifteen things run
 * simultaneously is a worse starting point than one that admits it is a queue.
 * Dragging two tasks to overlap is a moment's work; discovering that a chart
 * lied about capacity is not.
 */
export function planFromLines(
  lines: readonly QuoteLine[],
  opts: { startsOn: string; unitFor: (description: string) => string | null; holidays?: Holidays }
): PlannedTask[] {
  const out: PlannedTask[] = [];
  let cursor = nextWorkingDay(opts.startsOn, opts.holidays);

  for (const line of lines) {
    const name = line.description.trim().slice(0, 140);
    /* A line with no description is a subtotal, a spacer or a mistake. It has
       no name, so it cannot become a task somebody can act on. */
    if (!name) continue;

    const { workingDays, durationKnown } = daysForLine(line.quantity, opts.unitFor(name));
    const dueOn = finishAfter(cursor, workingDays, opts.holidays);
    out.push({ name, workingDays, startsOn: cursor, dueOn, durationKnown });

    // Finish to start: the next task begins the working day after this one ends.
    cursor = nextWorkingDay(addDay(dueOn), opts.holidays);
  }
  return out;
}

/** The next calendar day, before the working-day rule is applied to it. */
function addDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Recover a line's unit from the price list.
 *
 * By name, because a quote line does not reference the price item it was drawn
 * from — it copies the text. That link is worth adding one day; until it is,
 * this matches the way a person would: same words, ignoring case and spacing.
 */
export function unitLookup(
  items: readonly { name: string; unit: string }[]
): (description: string) => string | null {
  const byName = new Map(items.map((i) => [normalise(i.name), i.unit]));
  return (description) => byName.get(normalise(description)) ?? null;
}

const normalise = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/* ------------------------------------------------------------------ */
/* Turning that into a real schedule                                   */
/* ------------------------------------------------------------------ */

/**
 * Which quotation a plan is allowed to come from.
 *
 * In preference order, and every one of these is a document a PERSON has
 * signed off. A `draft` or one still `awaiting_approval` is excluded
 * deliberately: those are what an agent wrote and nobody has agreed to yet,
 * and the standing rule in this product is that the AI drafts, a named human
 * approves, and only then does anything count. A plan built from an unapproved
 * draft would make the agent's guess into the shape of the job.
 */
export const PLANNABLE_STATUSES = ["accepted", "sent", "approved"] as const;

export type BuildResult = {
  error?: string;
  created?: number;
  /** How many lengths were inferred rather than read — said on screen. */
  assumed?: number;
  quoteNumber?: string;
};

/**
 * Build the plan, or say why it cannot be built.
 *
 * Refuses when the project already has tasks. Merging a quotation into a
 * schedule somebody has been maintaining is a different and much harder
 * feature — it would have to decide what is the same task and what is new —
 * and silently appending fifteen duplicates would be worse than doing nothing.
 * So this is a starting point for an empty plan, and says so.
 */
export async function buildPlanFromQuote(
  q: TenantQuery,
  dealId: string
): Promise<BuildResult> {
  const existing = await listTasks(q, dealId);
  if (existing.length > 0) {
    return {
      error:
        "This project already has a schedule. Building from the quotation only fills an empty plan — add the tasks you need, or clear the plan first.",
    };
  }

  const doc = await q.one<{ id: string; number: string; starts_on: string | null }>(
    `SELECT d.id, d.number, deal.starts_on::text AS starts_on
       FROM documents d
       JOIN deals deal ON deal.id = d.deal_id AND deal.sub_account_id = d.sub_account_id
      WHERE d.sub_account_id = $1
        AND d.deal_id = $2
        AND d.kind = 'quote'
        AND d.deleted_at IS NULL
        AND d.status = ANY($3::text[])
      -- The client's yes outranks anything we merely sent, whatever the dates
      -- say: array_position orders by intent rather than by recency.
      ORDER BY array_position($3::text[], d.status), d.created_at DESC
      LIMIT 1`,
    [q.ctx.subAccountId, dealId, [...PLANNABLE_STATUSES]]
  );
  if (!doc) {
    return {
      error:
        "There is no approved quotation on this project yet. A plan is built from work somebody has agreed to — approve a quotation and it can lay the schedule out for you.",
    };
  }

  const lines = await q.rows<{ description: string; quantity: string }>(
    `SELECT description, quantity::text AS quantity FROM document_lines
      WHERE sub_account_id = $1 AND document_id = $2
      ORDER BY position ASC`,
    [q.ctx.subAccountId, doc.id]
  );
  if (lines.length === 0) return { error: `${doc.number} has no lines to plan from.` };

  const [items, closed] = await Promise.all([listPriceItems(q), holidaySet(q)]);

  /* The project's own start when it has one, otherwise the next working day.
     A plan that begins in the past is one somebody has to drag before they can
     read it. */
  const today = new Date().toISOString().slice(0, 10);
  const from = doc.starts_on && doc.starts_on > today ? doc.starts_on : today;

  const planned = planFromLines(
    lines.map((l) => ({ description: l.description, quantity: Number(l.quantity) })),
    { startsOn: from, unitFor: unitLookup(items), holidays: closed }
  );
  if (planned.length === 0) return { error: `${doc.number} has no lines that could become tasks.` };

  /* Written in order, each waiting on the one before it. The dependency is
     what makes the plan hold together afterwards: moving the first task
     cascades through the rest instead of leaving fifteen fixed dates that
     quietly stop meaning anything. */
  let created = 0;
  let previousId: string | null = null;
  for (const task of planned) {
    const result = await addTask(q, dealId, {
      name: task.name,
      startsOn: task.startsOn,
      dueOn: task.dueOn,
      percentComplete: 0,
      ownerUserId: null,
    });
    if (result.error || !result.task) continue;
    created += 1;

    if (previousId) await addDependency(q, dealId, result.task.id, previousId);
    previousId = result.task.id;
  }

  return {
    created,
    assumed: planned.filter((p) => !p.durationKnown).length,
    quoteNumber: doc.number,
  };
}
