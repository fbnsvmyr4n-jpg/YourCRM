import type { TenantQuery } from "../tenant";
import { type Holiday } from "../holidays";

/**
 * The workspace's own list of days it does not work.
 *
 * Read by the scheduler on every cascade, and edited by a person in Settings.
 * Nothing here generates dates — `src/server/holidays.ts` does that, and only
 * to fill this table. The distinction is the point: the schedule trusts what a
 * workspace has declared, never what this code assumed about their country.
 */

export type StoredHoliday = { id: string; onDate: string; name: string };

type Row = { id: string; on_date: string; name: string };

/** In date order, which is the only order a calendar reads in. */
export async function listHolidays(q: TenantQuery): Promise<StoredHoliday[]> {
  const rows = await q.rows<Row>(
    `SELECT id, on_date::text, name FROM workspace_holidays
      WHERE sub_account_id = $1
      ORDER BY on_date`,
    [q.ctx.subAccountId]
  );
  return rows.map((r) => ({ id: r.id, onDate: r.on_date, name: r.name }));
}

/**
 * The set the scheduler works from.
 *
 * A Set of `YYYY-MM-DD`, which is what `schedule.ts` takes — the dates never
 * become `Date` objects on the way, because a calendar day parsed in a zone
 * behind UTC comes back a day early and would close the office on the wrong
 * day.
 */
export async function holidaySet(q: TenantQuery): Promise<Set<string>> {
  const rows = await q.rows<{ on_date: string }>(
    `SELECT on_date::text FROM workspace_holidays WHERE sub_account_id = $1`,
    [q.ctx.subAccountId]
  );
  return new Set(rows.map((r) => r.on_date));
}

const newId = () => `hol-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export type HolidayResult = { added?: number; error?: string };

/**
 * Add days off.
 *
 * Takes a list rather than one date so importing a year is a single statement
 * and a single transaction — a half-added year would be a calendar nobody could
 * trust. Days already on the list are skipped rather than refused: adding 2026
 * twice should be a no-op, not an error message about Christmas.
 */
export async function addHolidays(q: TenantQuery, days: Holiday[]): Promise<HolidayResult> {
  const valid = days.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.onDate) && d.name.trim());
  if (valid.length === 0) return { error: "Give a date and a name." };

  const rows = await q.rows<{ id: string }>(
    `INSERT INTO workspace_holidays (id, sub_account_id, on_date, name)
     SELECT gen.id, $1, gen.on_date::date, gen.name
       FROM UNNEST($2::text[], $3::text[], $4::text[]) AS gen(id, on_date, name)
     ON CONFLICT (sub_account_id, on_date) DO NOTHING
     RETURNING id`,
    [
      q.ctx.subAccountId,
      valid.map(() => newId()),
      valid.map((d) => d.onDate),
      valid.map((d) => d.name.trim().slice(0, 80)),
    ]
  );
  return { added: rows.length };
}

export async function removeHoliday(q: TenantQuery, id: string): Promise<boolean> {
  const row = await q.one<{ id: string }>(
    `DELETE FROM workspace_holidays WHERE id = $2 AND sub_account_id = $1 RETURNING id`,
    [q.ctx.subAccountId, id]
  );
  return row !== null;
}
