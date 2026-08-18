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
  updatedAt: null,
};

type Row = {
  monthly_target_cents: string;
  weekly_capacity: number;
  updated_at: Date;
};

function toSettings(r: Row): Settings {
  return {
    monthlyTargetCents: Number(r.monthly_target_cents),
    weeklyCapacity: r.weekly_capacity,
    updatedAt: r.updated_at.toISOString(),
  };
}

/** Never throws for a sub-account that has not saved anything; returns defaults. */
export async function getSettings(q: TenantQuery): Promise<Settings> {
  const row = await q.one<Row>(
    `SELECT monthly_target_cents, weekly_capacity, updated_at
     FROM settings WHERE sub_account_id = $1`,
    [q.ctx.subAccountId]
  );
  return row ? toSettings(row) : { ...DEFAULT_SETTINGS };
}

export async function updateSettings(
  q: TenantQuery,
  patch: { monthlyTargetCents?: number; weeklyCapacity?: number }
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

  // Upsert: the first save for a sub-account must not require a separate
  // "create settings" step that something has to remember to run.
  const row = await q.one<Row>(
    `INSERT INTO settings (sub_account_id, monthly_target_cents, weekly_capacity)
     VALUES ($1, COALESCE($2, 0), COALESCE($3, ${DEFAULT_SETTINGS.weeklyCapacity}))
     ON CONFLICT (sub_account_id) DO UPDATE SET
       monthly_target_cents = COALESCE($2, settings.monthly_target_cents),
       weekly_capacity      = COALESCE($3, settings.weekly_capacity),
       updated_at           = now()
     RETURNING monthly_target_cents, weekly_capacity, updated_at`,
    [q.ctx.subAccountId, patch.monthlyTargetCents ?? null, patch.weeklyCapacity ?? null]
  );
  if (!row) throw new Error("Settings were not saved.");
  return toSettings(row);
}
