import type { SystemQuery } from "../tenant";
import {
  emptyReport,
  matchContact,
  splitName,
  toCents,
  toTimestamp,
  LEAD_STATUS_MAP,
  MEETING_KIND_MAP,
  OUTCOME_MAP,
  SOURCE_MAP,
  STAGE_MAP,
  type ContactKey,
  type LegacyContact,
  type LegacyDeal,
  type LegacyLead,
  type LegacyMeeting,
  type LegacyMessage,
  type MigrationReport,
} from "./from-jsonb";

/**
 * Runs the migration.
 *
 * Uses `SystemQuery`, not a tenant one, because this is the moment the tenant
 * comes into existence — there is nothing to scope to until the agency and its
 * first sub-account have been written. Every statement names the target
 * sub-account explicitly instead.
 *
 * Everything happens inside the caller's transaction. Nothing here touches
 * `crm_collections`: the old data is read and left exactly as it was, so the
 * rollback is "point the app back at the old path", not "restore a backup".
 * That is the difference between a reversible migration and a hopeful one.
 */

type Legacy = {
  contacts: LegacyContact[];
  leads: LegacyLead[];
  deals: LegacyDeal[];
  meetings: LegacyMeeting[];
  messages: LegacyMessage[];
  settings?: { monthlyTarget?: number; weeklyCapacity?: number };
};

export type MigrateOptions = {
  agencyId: string;
  agencyName: string;
  subAccountId: string;
  subAccountName: string;
  /**
   * The zone the legacy wall-clock times were written in.
   *
   * No default guess: those strings carry no zone, so this is a decision about
   * what the person who typed "2:00 pm" meant, and it belongs to whoever knows
   * the answer rather than to whichever machine runs the migration.
   */
  legacyTimeZone: string;
};

/** Read a JSONB collection, tolerating one that was never created. */
export async function readCollection<T>(q: SystemQuery, name: string): Promise<T[]> {
  const row = await q.one<{ data: T[] }>(`SELECT data FROM crm_collections WHERE name = $1`, [name]);
  return row?.data ?? [];
}

export async function loadLegacy(q: SystemQuery): Promise<Legacy> {
  const [contacts, leads, deals, meetings, messages, settings] = [
    await readCollection<LegacyContact>(q, "contacts"),
    await readCollection<LegacyLead>(q, "leads"),
    await readCollection<LegacyDeal>(q, "deals"),
    await readCollection<LegacyMeeting>(q, "meetings"),
    // The collection is named `messages`, not `inbox`. Reading the wrong name
    // returned an empty array rather than an error, so every message would have
    // migrated as zero and the verification would have compared 0 against 0 and
    // passed. Found by rehearsing against a copy of production, which is the
    // entire reason for rehearsing against a copy of production.
    await readCollection<LegacyMessage>(q, "messages"),
    await readCollection<{ monthlyTarget?: number; weeklyCapacity?: number }>(q, "settings"),
  ];
  return { contacts, leads, deals, meetings, messages, settings: settings[0] };
}

export async function migrate(
  q: SystemQuery,
  legacy: Legacy,
  opts: MigrateOptions
): Promise<MigrationReport> {
  const report = emptyReport();
  const { subAccountId } = opts;

  report.read = {
    contacts: legacy.contacts.length,
    leads: legacy.leads.length,
    deals: legacy.deals.length,
    meetings: legacy.meetings.length,
    messages: legacy.messages.length,
  };

  // --- Tenant root -----------------------------------------------------------
  // The existing workspace becomes agency #1 and its primary sub-account, so
  // "view across my clients" is a query rather than a special case later.
  await q.rows(
    `INSERT INTO agencies (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
    [opts.agencyId, opts.agencyName]
  );
  await q.rows(
    `INSERT INTO sub_accounts (id, agency_id, name, is_primary)
     VALUES ($1, $2, $3, TRUE) ON CONFLICT (id) DO NOTHING`,
    [subAccountId, opts.agencyId, opts.subAccountName]
  );

  // --- Contacts --------------------------------------------------------------
  const keys: ContactKey[] = [];
  for (const c of legacy.contacts) {
    const name = `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim();
    await q.rows(
      `INSERT INTO contacts (id, sub_account_id, first_name, last_name, email, phone, info, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, now()))
       ON CONFLICT (id) DO NOTHING`,
      [
        c.id,
        subAccountId,
        c.firstName ?? "",
        c.lastName ?? "",
        c.email?.trim() || null,
        c.phone?.trim() || null,
        // The company name has nowhere better to go until companies are real
        // entities; keeping it in `info` preserves it rather than dropping it.
        c.companyInfo?.trim() || c.company?.trim() || c.info?.trim() || null,
        c.createdAt ?? null,
      ]
    );
    keys.push({
      id: c.id,
      email: (c.email ?? "").trim().toLowerCase(),
      name: name.toLowerCase(),
    });
  }
  report.written.contacts = legacy.contacts.length;

  // --- Leads become contacts + deals ----------------------------------------
  // The heart of it. A lead was a duplicate of a person who might already be a
  // contact, so each one is either merged into that contact or becomes a new
  // one — and then gets a deal, because "this person is a lead" is now
  // expressed by having an open deal rather than by a stored status.
  let newContactsFromLeads = 0;
  for (const lead of legacy.leads) {
    let contactId = matchContact({ email: lead.email, name: lead.name }, keys);

    if (contactId) {
      report.leadsMerged += 1;
    } else {
      const { first, last } = splitName(lead.name);
      contactId = `lead-${lead.id}`;
      await q.rows(
        `INSERT INTO contacts (id, sub_account_id, first_name, last_name, email, phone, location, info, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, now()))
         ON CONFLICT (id) DO NOTHING`,
        [
          contactId,
          subAccountId,
          first,
          last,
          lead.email?.trim() || null,
          lead.phone?.trim() || null,
          lead.location?.trim() || null,
          lead.company?.trim() || null,
          lead.createdAt ?? null,
        ]
      );
      keys.push({
        id: contactId,
        email: (lead.email ?? "").trim().toLowerCase(),
        name: (lead.name ?? "").trim().toLowerCase(),
      });
      newContactsFromLeads += 1;
    }

    const stage = LEAD_STATUS_MAP[lead.status ?? ""] ?? "prospect";
    const source = SOURCE_MAP[lead.source ?? ""] ?? "other";
    if (lead.status && !LEAD_STATUS_MAP[lead.status]) {
      report.warnings.push(`lead ${lead.id}: unknown status "${lead.status}", filed as prospect`);
    }
    if (lead.source && !SOURCE_MAP[lead.source]) {
      report.warnings.push(`lead ${lead.id}: unknown source "${lead.source}", filed as other`);
    }

    await q.rows(
      `INSERT INTO deals (id, sub_account_id, contact_id, title, value_cents, stage, source, won_at, created_at)
       VALUES ($1, $2, $3, $4, 0, $5, $6, CASE WHEN $5 = 'won' THEN COALESCE($7::timestamptz, now()) END,
               COALESCE($7::timestamptz, now()))
       ON CONFLICT (id) DO NOTHING`,
      [
        `lead-deal-${lead.id}`,
        subAccountId,
        contactId,
        // A lead carries no deal title, so it says what it is rather than
        // inventing something that looks like a real opportunity name.
        lead.name?.trim() ? `${lead.name.trim()} — enquiry` : "Enquiry",
        stage,
        source,
        lead.createdAt ?? null,
      ]
    );
  }
  report.written.contacts += newContactsFromLeads;
  report.written.dealsFromLeads = legacy.leads.length;

  // --- Deals -----------------------------------------------------------------
  for (const d of legacy.deals) {
    const stage = STAGE_MAP[d.stage ?? ""] ?? "prospect";
    if (d.stage && !STAGE_MAP[d.stage]) {
      report.warnings.push(`deal ${d.id}: unknown stage "${d.stage}", filed as prospect`);
    }
    const contactId = matchContact({ name: d.contact }, keys);
    if (d.contact && !contactId) {
      // Not fatal: the deal still migrates, it is simply unlinked. Reported so
      // somebody can join it up rather than discovering it on a screen.
      report.warnings.push(`deal ${d.id}: no contact matched "${d.contact}", left unlinked`);
    }

    await q.rows(
      `INSERT INTO deals (id, sub_account_id, contact_id, title, value_cents, stage, source,
                          won_at, split_id, split_total_cents)
       VALUES ($1, $2, $3, $4, $5, $6, 'other', $7::timestamptz, $8, $9)
       ON CONFLICT (id) DO NOTHING`,
      [
        d.id,
        subAccountId,
        contactId,
        d.title?.trim() || "Untitled deal",
        toCents(d.value),
        stage,
        // Only a recorded wonAt counts. A deal sitting in the won column with
        // no timestamp is not evidence that it was won on any particular day,
        // so it keeps the stage and reports no date rather than inventing one.
        d.wonAt ?? null,
        d.splitId ?? null,
        d.splitTotal != null ? toCents(d.splitTotal) : null,
      ]
    );
  }
  report.written.deals = legacy.deals.length;

  // --- Meetings --------------------------------------------------------------
  for (const m of legacy.meetings) {
    const at = toTimestamp(m.date, m.time, opts.legacyTimeZone);
    if (!at) {
      report.warnings.push(`meeting ${m.id}: no usable date, skipped`);
      continue;
    }
    const outcome = OUTCOME_MAP[m.outcome ?? "scheduled"] ?? "scheduled";
    const contactId = matchContact({ email: m.email, name: m.name }, keys);

    await q.rows(
      `INSERT INTO meetings (id, sub_account_id, contact_id, topic, scheduled_at, kind,
                             join_url, notes, outcome, loss_reason)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9,
               CASE WHEN $9 = 'lost' THEN $10 END)
       ON CONFLICT (id) DO NOTHING`,
      [
        m.id,
        subAccountId,
        contactId,
        m.topic?.trim() || "",
        at,
        MEETING_KIND_MAP[m.type ?? ""] ?? "online",
        m.link?.trim() || null,
        m.notes?.trim() || null,
        outcome,
        m.lossReason ?? null,
      ]
    );
  }
  report.written.meetings = legacy.meetings.filter((m) => toTimestamp(m.date, m.time, opts.legacyTimeZone)).length;

  // --- Messages --------------------------------------------------------------
  for (const msg of legacy.messages) {
    const contactId = matchContact({ email: msg.email, name: msg.name }, keys);
    await q.rows(
      `INSERT INTO messages (id, sub_account_id, contact_id, direction, subject, body,
                             category, unread, sent_at, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, now()),
               CASE WHEN $10 THEN COALESCE($9::timestamptz, now()) END)
       ON CONFLICT (id) DO NOTHING`,
      [
        msg.id,
        subAccountId,
        contactId,
        msg.direction === "sent" ? "sent" : "received",
        msg.subject ?? "",
        // Paragraphs rejoined the way the classifier splits them, so a message
        // categorises after the migration exactly as it did before.
        (msg.body ?? []).join("\n\n"),
        msg.category ?? null,
        msg.unread ?? false,
        msg.at ?? null,
        // "Trashed" becomes a tombstone, which is what the bin already was.
        msg.trashed ?? false,
      ]
    );
  }
  report.written.messages = legacy.messages.length;

  // --- Settings --------------------------------------------------------------
  if (legacy.settings) {
    await q.rows(
      `INSERT INTO settings (sub_account_id, monthly_target_cents, weekly_capacity, time_zone)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (sub_account_id) DO UPDATE SET
         monthly_target_cents = EXCLUDED.monthly_target_cents,
         weekly_capacity = EXCLUDED.weekly_capacity,
         time_zone = EXCLUDED.time_zone`,
      [
        subAccountId,
        toCents(legacy.settings.monthlyTarget),
        legacy.settings.weeklyCapacity ?? 20,
        // The same zone the legacy timestamps were read in. Landing on UTC here
        // would mean every migrated meeting is stored correctly and every
        // meeting booked afterwards is an hour or two out — a subtler version
        // of the bug the zone was introduced to fix.
        opts.legacyTimeZone,
      ]
    );
    report.written.settings = 1;
  }

  return report;
}

export type Verification = {
  ok: boolean;
  checks: { name: string; expected: number; actual: number; ok: boolean }[];
};

/**
 * Count the result independently and compare it to the source.
 *
 * Deliberately re-derived from the legacy documents rather than from the report
 * the migration just produced — a migration checking its own arithmetic proves
 * only that it is self-consistent. This is the step that would catch a write
 * silently doing nothing, which `ON CONFLICT DO NOTHING` makes possible.
 */
export async function verify(
  q: SystemQuery,
  legacy: Legacy,
  subAccountId: string,
  legacyTimeZone = "UTC"
): Promise<Verification> {
  const count = async (table: string, extra = "") => {
    const row = await q.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table} WHERE sub_account_id = $1 ${extra}`,
      [subAccountId]
    );
    return Number(row?.n ?? 0);
  };

  const legacyMoney = legacy.deals.reduce((sum, d) => sum + toCents(d.value), 0);
  const migratedMoney = Number(
    (
      await q.one<{ n: string }>(
        `SELECT COALESCE(SUM(value_cents), 0)::text AS n FROM deals
         WHERE sub_account_id = $1 AND id NOT LIKE 'lead-deal-%'`,
        [subAccountId]
      )
    )?.n ?? 0
  );

  const datedMeetings = legacy.meetings.filter((m) => toTimestamp(m.date, m.time, legacyTimeZone)).length;

  /**
   * Meetings are checked against the FULL legacy count, not against the ones
   * that happened to be migratable.
   *
   * The first version compared the result to `datedMeetings` — the same filter
   * the migration itself uses to skip undated rows — so it reported a pass
   * while quietly dropping 5 of 22 real meetings. A check derived from the
   * behaviour it is checking cannot fail; it is the proxy-signal mistake in its
   * purest form. The skipped rows now show up as an explicit shortfall that a
   * human has to accept before the real run.
   */
  const skipped = legacy.meetings.length - datedMeetings;

  const checks = [
    { name: "deals", expected: legacy.deals.length + legacy.leads.length, actual: await count("deals") },
    { name: "meetings", expected: legacy.meetings.length, actual: await count("meetings") },
    { name: "meetings skipped (no date)", expected: 0, actual: skipped },
    { name: "messages", expected: legacy.messages.length, actual: await count("messages") },
    // Every legacy contact survives; leads add only the ones that did not match.
    { name: "contacts (at least)", expected: legacy.contacts.length, actual: await count("contacts") },
    { name: "deal value in cents", expected: legacyMoney, actual: migratedMoney },
  ].map((c) => ({
    ...c,
    ok: c.name === "contacts (at least)" ? c.actual >= c.expected : c.actual === c.expected,
  }));

  return { ok: checks.every((c) => c.ok), checks };
}
