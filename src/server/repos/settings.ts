import type { TenantQuery } from "../tenant";
import { DEFAULT_CURRENCY, isCurrency, type CurrencyCode } from "@/lib/money";
import { instantToWallClock } from "@/lib/zoned";

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
  /** How clients are told to pay, printed at the foot of every invoice. */
  invoicePayTo: string | null;
  /** The currency every amount in this workspace is in. See `lib/money.ts`. */
  currency: CurrencyCode;
  /**
   * Whether an incoming message that asks for something becomes a task.
   *
   * On unless somebody turns it off — see the note in `schema.sql`.
   */
  tasksFromMessages: boolean;
  /**
   * The letterhead: who this business is, on the paperwork it issues.
   *
   * All nullable, and all omitted from a document when absent rather than
   * printed as a label with nothing after it. A tax invoice legally needs the
   * address, the registration number and the VAT number — but a business that
   * is not registered has no VAT number, and inventing one would be worse than
   * leaving it off.
   */
  businessAddress: string | null;
  businessPhone: string | null;
  businessEmail: string | null;
  registrationNumber: string | null;
  vatNumber: string | null;
  /**
   * The VAT rate in basis points: 1500 is 15%. Zero means not registered, and
   * then nothing about VAT appears on any document. `server/vat.ts` says why
   * basis points rather than a decimal.
   */
  vatRateBp: number;
  /**
   * Whether a price typed on a line already includes the VAT.
   *
   * The most consequential setting in this product: the same typed R1,000 is
   * either R1,150 to pay or R1,000 to pay, depending on it.
   */
  pricesIncludeVat: boolean;
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
  /* Null, never a placeholder. An invoice printing "Bank: your bank here" is
     worse than one that omits payment details entirely. */
  invoicePayTo: null,
  currency: DEFAULT_CURRENCY,
  /* On for a workspace that has never saved anything, so the default here
     agrees with the column default rather than quietly disagreeing with it. */
  tasksFromMessages: true,
  /* Nothing invented here either. A document prints what the business has told
     us about itself and no more. */
  businessAddress: null,
  businessPhone: null,
  businessEmail: null,
  registrationNumber: null,
  vatNumber: null,
  /* Not registered until somebody says so. A default rate would put a tax line
     on the documents of every business that never asked for one. */
  vatRateBp: 0,
  pricesIncludeVat: false,
  updatedAt: null,
};

type Row = {
  monthly_target_cents: string;
  weekly_capacity: number;
  time_zone: string;
  invoice_pay_to: string | null;
  currency: string;
  tasks_from_messages: boolean;
  business_address: string | null;
  business_phone: string | null;
  business_email: string | null;
  registration_number: string | null;
  vat_number: string | null;
  vat_rate_bp: number;
  prices_include_vat: boolean;
  updated_at: Date;
};

const COLUMNS = `monthly_target_cents, weekly_capacity, time_zone, invoice_pay_to, currency, tasks_from_messages,
                 business_address, business_phone, business_email, registration_number, vat_number,
                 vat_rate_bp, prices_include_vat, updated_at`;

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
    invoicePayTo: r.invoice_pay_to,
    /* A code this build does not know — added by a newer deployment, say —
       shows as the default rather than breaking every page that prints money. */
    currency: isCurrency(r.currency) ? r.currency : DEFAULT_CURRENCY,
    tasksFromMessages: r.tasks_from_messages,
    businessAddress: r.business_address,
    businessPhone: r.business_phone,
    businessEmail: r.business_email,
    registrationNumber: r.registration_number,
    vatNumber: r.vat_number,
    /* A rate outside what the column allows cannot be stored, but a row written
       by an older build has none at all — and `undefined` × anything is NaN on
       a document. Zero means "show no tax", which is the safe reading. */
    vatRateBp: Number.isFinite(Number(r.vat_rate_bp)) ? Number(r.vat_rate_bp) : 0,
    pricesIncludeVat: r.prices_include_vat === true,
    updatedAt: r.updated_at.toISOString(),
  };
}

/** Never throws for a sub-account that has not saved anything; returns defaults. */
export async function getSettings(q: TenantQuery): Promise<Settings> {
  const row = await q.one<Row>(
    `SELECT ${COLUMNS}
     FROM settings WHERE sub_account_id = $1`,
    [q.ctx.subAccountId]
  );
  return row ? toSettings(row) : { ...DEFAULT_SETTINGS };
}

/**
 * Today's date in this business's own calendar, as `YYYY-MM-DD`.
 *
 * For anything that stamps a day onto a record — a quotation's issue date, the
 * day a plan starts. The database's `CURRENT_DATE` and the server's clock are
 * both UTC in production, which in Johannesburg is yesterday until 02:00 and
 * in Auckland is yesterday until lunchtime; a document issued "today" must
 * carry the day the business was actually in.
 */
export async function businessToday(q: TenantQuery): Promise<string> {
  const { timeZone } = await getSettings(q);
  return (
    instantToWallClock(new Date().toISOString(), timeZone)?.date ?? new Date().toISOString().slice(0, 10)
  );
}

export async function updateSettings(
  q: TenantQuery,
  patch: {
    monthlyTargetCents?: number;
    weeklyCapacity?: number;
    timeZone?: string;
    invoicePayTo?: string | null;
    currency?: CurrencyCode;
    tasksFromMessages?: boolean;
    businessAddress?: string | null;
    businessPhone?: string | null;
    businessEmail?: string | null;
    registrationNumber?: string | null;
    vatNumber?: string | null;
    vatRateBp?: number;
    pricesIncludeVat?: boolean;
  }
): Promise<Settings> {
  if (patch.currency !== undefined && !isCurrency(patch.currency)) {
    throw new Error("That is not a currency this workspace can use.");
  }
  if (patch.vatRateBp !== undefined) {
    /* The same bounds the column enforces, checked here so the message is
       about tax rather than a constraint name. Whole basis points only: a
       fractional one is a rate the arithmetic cannot represent exactly, which
       is the entire reason the rate is not stored as a decimal. */
    if (!Number.isInteger(patch.vatRateBp) || patch.vatRateBp < 0 || patch.vatRateBp > 10000) {
      throw new Error("A VAT rate must be between 0% and 100%.");
    }
  }
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
    `INSERT INTO settings (sub_account_id, monthly_target_cents, weekly_capacity, time_zone, invoice_pay_to, currency, tasks_from_messages,
                           business_address, business_phone, business_email, registration_number, vat_number,
                           vat_rate_bp, prices_include_vat)
     VALUES ($1, COALESCE($2, 0), COALESCE($3, ${DEFAULT_SETTINGS.weeklyCapacity}), COALESCE($4, 'UTC'), $5,
             COALESCE($7, '${DEFAULT_CURRENCY}'), COALESCE($8, TRUE),
             $9, $11, $13, $15, $17, COALESCE($19, 0), COALESCE($20, FALSE))
     ON CONFLICT (sub_account_id) DO UPDATE SET
       monthly_target_cents = COALESCE($2, settings.monthly_target_cents),
       weekly_capacity      = COALESCE($3, settings.weekly_capacity),
       time_zone            = COALESCE($4, settings.time_zone),
       currency             = COALESCE($7, settings.currency),
       -- COALESCE is right here and wrong for invoice_pay_to below: a boolean
       -- that was not mentioned is null, which means leave it, and false is a
       -- real value that COALESCE keeps.
       tasks_from_messages  = COALESCE($8, settings.tasks_from_messages),
       -- $6 says whether the caller mentioned it at all, so an empty box
       -- CLEARS the details rather than being mistaken for "leave as they
       -- were", which is what COALESCE alone would do and would make removing
       -- bank details impossible.
       invoice_pay_to       = CASE WHEN $6::boolean THEN $5 ELSE settings.invoice_pay_to END,
       -- Every letterhead field takes the same pair: the value, and whether it
       -- was mentioned. A business that deregisters for VAT, moves premises or
       -- drops a phone number must be able to EMPTY one of these, and a company
       -- that keeps printing an address it has left is the failure this avoids.
       business_address     = CASE WHEN $10::boolean THEN $9  ELSE settings.business_address END,
       business_phone       = CASE WHEN $12::boolean THEN $11 ELSE settings.business_phone END,
       business_email       = CASE WHEN $14::boolean THEN $13 ELSE settings.business_email END,
       registration_number  = CASE WHEN $16::boolean THEN $15 ELSE settings.registration_number END,
       vat_number           = CASE WHEN $18::boolean THEN $17 ELSE settings.vat_number END,
       vat_rate_bp          = COALESCE($19, settings.vat_rate_bp),
       -- Boolean, so COALESCE again: false is a real answer and must survive.
       prices_include_vat   = COALESCE($20, settings.prices_include_vat),
       updated_at           = now()
     RETURNING ${COLUMNS}`,
    [
      q.ctx.subAccountId,
      patch.monthlyTargetCents ?? null,
      patch.weeklyCapacity ?? null,
      patch.timeZone ?? null,
      patch.invoicePayTo ?? null,
      patch.invoicePayTo !== undefined,
      patch.currency ?? null,
      patch.tasksFromMessages ?? null,
      patch.businessAddress ?? null,
      patch.businessAddress !== undefined,
      patch.businessPhone ?? null,
      patch.businessPhone !== undefined,
      patch.businessEmail ?? null,
      patch.businessEmail !== undefined,
      patch.registrationNumber ?? null,
      patch.registrationNumber !== undefined,
      patch.vatNumber ?? null,
      patch.vatNumber !== undefined,
      patch.vatRateBp ?? null,
      patch.pricesIncludeVat ?? null,
    ]
  );
  if (!row) throw new Error("Settings were not saved.");
  return toSettings(row);
}
