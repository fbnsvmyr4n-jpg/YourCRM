import type { TenantQuery } from "../tenant";

/**
 * Per-sub-account settings.
 *
 * The single most important change from the version this replaces: settings
 * were a global singleton keyed `SETTINGS_ID = "workspace"`, so every customer
 * on the platform would have shared one monthly target and one meeting
 * capacity. The row is now keyed BY `sub_account_id`, which makes that
 * impossible to express rather than merely unlikely.
 *
 * Money is stored in cents like everywhere else. The old type held
 * `monthlyTarget` in whole currency units, so the same concept existed in two
 * scales in one codebase — the kind of mismatch that produces a target 100×
 * too large exactly once, in front of a customer.
 */

export type Settings = {
  /** Revenue goal for the current month, in integer cents. */
  monthlyTargetCents: number;
  /** How many meetings a week the team considers a full load. */
  weeklyCapacity: number;
  /**
   * IANA zone this business works in, e.g. "Africa/Johannesburg".
   *
   * Booking forms submit wall-clock times with no zone. This is what turns
   * one into an instant, so the answer does not depend on which server
   * happened to handle the request.
   */
  timeZone: string;
  updatedAt: string | null;
};

/**
 * What a sub-account gets before anyone has chosen anything.
 *
 * The target is zero, not a made-up figure. A default of 50,000 would render
 * as a real goal on the dashboard and quietly make every progress bar a
 * fiction — the same rule as never showing an invented number. Capacity has a
 * sane default because a zero there would divide into an infinite workload.
 */
export const DEFAULT_SETTINGS: Settings = {
  monthlyTargetCents: 0,
  weeklyCapacity: 20,
  // UTC until somebody says otherwise. Guessing from the server's clock is
  // exactly the mistake this field exists to prevent.
  timeZone: "UTC",
  updatedAt: null,
};

type Row = {
  monthly_target_cents: string;
  weekly_capacity: number;
  time_zone: string;
  updated_at: Date;
};

/** Rejects anything `Intl` cannot resolve, rather than storing a typo. */
export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function toSettings(r: Row): Settings {
  return {
    monthlyTargetCents: Number(r.monthly_target_cents),
    weeklyCapacity: r.weekly_capacity,
    timeZone: r.time_zone,
    updatedAt: r.updated_at.toISOString(),
  };
}

/** Never throws for a sub-account that has not saved anything; returns defaults. */
export async function getSettings(q: TenantQuery): Promise<Settings> {
  const row = await q.one<Row>(
    `SELECT monthly_target_cents, weekly_capacity, time_zone, updated_at
     FROM settings WHERE sub_account_id = $1`,
    [q.ctx.subAccountId]
  );
  return row ? toSettings(row) : { ...DEFAULT_SETTINGS };
}

export async function updateSettings(
  q: TenantQuery,
  patch: { monthlyTargetCents?: number; weeklyCapacity?: number; timeZone?: string }
): Promise<Settings> {
  if (patch.monthlyTargetCents !== undefined) {
    if (!Number.isSafeInteger(patch.monthlyTargetCents) || patch.monthlyTargetCents < 0) {
      throw new Error("Monthly target must be whole cents, and not negative.");
    }
  }
  if (patch.weeklyCapacity !== undefined) {
    // Zero capacity would make every "x of y meetings" divide by zero, and a
    // fractional meeting is not a thing anyone can book.
    if (!Number.isInteger(patch.weeklyCapacity) || patch.weeklyCapacity < 1) {
      throw new Error("Weekly capacity must be a whole number of at least 1.");
    }
  }

  if (patch.timeZone !== undefined && !isValidTimeZone(patch.timeZone)) {
    throw new Error("That is not a recognised time zone.");
  }

  // Upsert: the first save for a sub-account must not require a separate
  // "create settings" step that something has to remember to run.
  const row = await q.one<Row>(
    `INSERT INTO settings (sub_account_id, monthly_target_cents, weekly_capacity, time_zone)
     VALUES ($1, COALESCE($2, 0), COALESCE($3, ${DEFAULT_SETTINGS.weeklyCapacity}), COALESCE($4, 'UTC'))
     ON CONFLICT (sub_account_id) DO UPDATE SET
       monthly_target_cents = COALESCE($2, settings.monthly_target_cents),
       weekly_capacity      = COALESCE($3, settings.weekly_capacity),
       time_zone            = COALESCE($4, settings.time_zone),
       updated_at           = now()
     RETURNING monthly_target_cents, weekly_capacity, time_zone, updated_at`,
    [q.ctx.subAccountId, patch.monthlyTargetCents ?? null, patch.weeklyCapacity ?? null, patch.timeZone ?? null]
  );
  if (!row) throw new Error("Settings were not saved.");
  return toSettings(row);
}
