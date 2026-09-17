import { Client } from "pg";

/**
 * A small, hand-checkable fixture for the dev database.
 *
 * Every figure this puts in is a round number chosen so the totals on screen
 * can be worked out on paper and compared — which is how the audits in this
 * project have found real defects (a 0.5% loss rate, Win Rate measuring a month
 * against all-time losses, "0 of 11 leads captured"). A fixture of realistic
 * noise proves nothing; this one is meant to be arithmetic.
 *
 * It REPLACES the CRM records in the demo workspace and touches nothing else —
 * no users, no settings beyond the currency, no other workspace. Run it with:
 *
 *   npx tsx --env-file=.env.local scripts/dev-seed.ts
 *
 * It refuses to run against anything but a local database.
 */

const day = (n: number) => `now() - interval '${n} days'`;
const isoDay = (n: number) => {
  const d = new Date(Date.now() - n * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** The money, in whole rand. Cents are these times 100. */
const DEALS = {
  won_roof: 120_000,
  won_fence: 80_000,
  delivery_paving: 60_000,
  lost_pool: 50_000,
  prospect_deck: 30_000,
  discovery_garage: 45_000,
  demo_solar: 25_000,
};

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const host = new URL(url).hostname;
  if (!["127.0.0.1", "localhost"].includes(host)) {
    throw new Error(`Refusing to seed ${host}: this is for the local dev database only.`);
  }
  const db = new Client({ connectionString: url });
  await db.connect();

  const owner = (await db.query<{ id: string; agency_id: string }>(
    `SELECT id, agency_id FROM users WHERE email = 'demo@yourcrm.com'`
  )).rows[0];
  if (!owner) throw new Error("No demo user — run `npm run dev:db` first.");
  const sub = (await db.query<{ id: string }>(
    `SELECT id FROM sub_accounts WHERE agency_id = $1 ORDER BY is_primary DESC, created_at LIMIT 1`,
    [owner.agency_id]
  )).rows[0];

  await db.query("BEGIN");
  try {
    /* A colleague to assign work to, so "mine" and "somebody else's" differ. */
    await db.query(
      `INSERT INTO users (id, agency_id, sub_account_id, email, password_hash, name, role)
       VALUES ('u-sam', $1, $2, 'sam@yourcrm.com', 'x', 'Sam Carter', 'member')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role`,
      [owner.agency_id, sub.id]
    );

    /* Out of the workspace's own records, in dependency order. */
    for (const table of [
      "audit_events", "invoice_payments", "document_lines", "documents", "retainers", "tickets",
      "todos", "message_templates", "contact_tags", "contact_views", "tags", "activities",
      "messages", "meetings", "deals", "contacts", "companies",
    ]) {
      if (table === "audit_events") {
        await db.query(`ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only`);
        await db.query(`DELETE FROM audit_events WHERE sub_account_id = $1`, [sub.id]);
        await db.query(`ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only`);
        continue;
      }
      await db.query(`DELETE FROM ${table} WHERE sub_account_id = $1`, [sub.id]);
    }

    /* INSERT … ON CONFLICT, not UPDATE: a workspace may have no settings row
       at all (the demo one does not), and an UPDATE then changes nothing while
       looking like it worked — every amount stayed in dollars. */
    await db.query(
      `INSERT INTO settings (sub_account_id, currency) VALUES ($1, 'ZAR')
       ON CONFLICT (sub_account_id) DO UPDATE SET currency = 'ZAR'`,
      [sub.id]
    );

    await db.query(
      `INSERT INTO companies (id, sub_account_id, name) VALUES
         ('co-dube', $1, 'Dube Landscaping'),
         ('co-khumalo', $1, 'Khumalo Build')`,
      [sub.id]
    );

    /* Six people: three become clients (they have a won deal), three are leads. */
    await db.query(
      `INSERT INTO contacts (id, sub_account_id, first_name, last_name, email, phone, location, company_id, owner_user_id, created_at) VALUES
         ('ct-amara',  $1, 'Amara',   'Dube',    'amara@dube.test',    '+27 82 555 0101', 'Cape Town',     'co-dube',    $2, ${day(40)}),
         ('ct-lindiwe',$1, 'Lindiwe', 'Khumalo', 'lindiwe@khumalo.test','+27 82 555 0102', 'Johannesburg',  'co-khumalo', $2, ${day(35)}),
         ('ct-ben',    $1, 'Ben',     'Cole',    'ben@cole.test',       '+27 82 555 0103', 'Durban',        NULL,         'u-sam', ${day(30)}),
         ('ct-thandi', $1, 'Thandi',  'Nkosi',   'thandi@nkosi.test',   '+27 82 555 0104', 'Pretoria',      NULL,         $2, ${day(20)}),
         ('ct-pieter', $1, 'Pieter',  'Venter',  'pieter@venter.test',  NULL,              'Stellenbosch',  NULL,         'u-sam', ${day(10)}),
         ('ct-sarah',  $1, 'Sarah',   'Adams',   'sarah@adams.test',    '+27 82 555 0106', 'Cape Town',     NULL,         $2, ${day(3)})`,
      [sub.id, owner.id]
    );

    await db.query(
      `INSERT INTO deals (id, sub_account_id, owner_user_id, contact_id, company_id, title, value_cents, stage, source, won_at, lost_at, created_at) VALUES
         ('d-roof',      $1, $2,      'ct-amara',   'co-dube',    'Roof replacement',   ${DEALS.won_roof * 100},          'won',       'website',  ${day(10)}, NULL,       ${day(38)}),
         ('d-fence',     $1, 'u-sam', 'ct-lindiwe', 'co-khumalo', 'Perimeter fencing',  ${DEALS.won_fence * 100},         'won',       'referral', ${day(40)}, NULL,       ${day(60)}),
         ('d-paving',    $1, $2,      'ct-ben',     NULL,         'Paving — phase 1',   ${DEALS.delivery_paving * 100},   'delivery',  'website',  ${day(5)},  NULL,       ${day(25)}),
         ('d-pool',      $1, $2,      'ct-thandi',  NULL,         'Pool deck',          ${DEALS.lost_pool * 100},         'lost',      'facebook', NULL,       ${day(12)}, ${day(30)}),
         ('d-deck',      $1, 'u-sam', 'ct-pieter',  NULL,         'Timber deck',        ${DEALS.prospect_deck * 100},     'prospect',  'website',  NULL,       NULL,       ${day(8)}),
         ('d-garage',    $1, $2,      'ct-sarah',   NULL,         'Garage conversion',  ${DEALS.discovery_garage * 100},  'discovery', 'referral', NULL,       NULL,       ${day(6)}),
         ('d-solar',     $1, $2,      'ct-amara',   'co-dube',    'Solar install',      ${DEALS.demo_solar * 100},        'demo',      'google_ads',   NULL,       NULL,       ${day(2)})`,
      [sub.id, owner.id]
    );

    /* Meetings: two ahead, one in the past nobody has recorded an outcome for. */
    await db.query(
      `INSERT INTO meetings (id, sub_account_id, owner_user_id, contact_id, deal_id, topic, scheduled_at, duration_min, outcome) VALUES
         ('mt-1', $1, $2, 'ct-pieter', 'd-deck',   'Site visit',      now() + interval '1 day',  60, 'scheduled'),
         ('mt-2', $1, $2, 'ct-sarah',  'd-garage', 'Design review',   now() + interval '3 days', 30, 'scheduled'),
         ('mt-3', $1, $2, 'ct-thandi', 'd-pool',   'Follow-up call',  now() - interval '2 days', 30, 'scheduled')`,
      [sub.id, owner.id]
    );

    /* Inbox: four received (two unread), two sent. */
    await db.query(
      `INSERT INTO messages (id, sub_account_id, contact_id, thread_id, direction, subject, body, unread, channel, delivery, sent_at) VALUES
         ('m-1', $1, 'ct-amara',   'th-roof',   'received', 'Roof — snag list',    'Two tiles are loose above the garage.', TRUE,  'email',    NULL,     ${day(1)}),
         ('m-2', $1, 'ct-ben',     'th-paving', 'received', 'Paving start date',   'When can the team start?',              TRUE,  'whatsapp', NULL,     ${day(2)}),
         ('m-3', $1, 'ct-lindiwe', 'th-fence',  'received', 'Invoice query',       'Was the last invoice paid?',            FALSE, 'email',    NULL,     ${day(4)}),
         ('m-4', $1, 'ct-pieter',  'th-deck',   'received', 'Timber options',      'Can we see samples?',                   FALSE, 'email',    NULL,     ${day(6)}),
         ('m-5', $1, 'ct-amara',   'th-roof',   'sent',     'Re: Roof — snag list','We will be there Thursday.',            FALSE, 'email',    'sent',   ${day(1)}),
         ('m-6', $1, 'ct-ben',     'th-paving', 'sent',     'Re: Paving start date','Pencilled in for the 3rd.',            FALSE, 'whatsapp', 'logged', ${day(2)})`,
      [sub.id]
    );

    /* Tickets: one open and past its reply time, one waiting on the customer. */
    await db.query(
      `INSERT INTO tickets (id, sub_account_id, thread_id, status, priority, assignee_user_id, awaiting_since) VALUES
         ('tk-roof',   $1, 'th-roof',   'open',    'urgent', $2, ${day(1)}),
         ('tk-paving', $1, 'th-paving', 'waiting', 'normal', 'u-sam', NULL)`,
      [sub.id, owner.id]
    );

    /* Tasks: one late, two today, one already done. */
    await db.query(
      `INSERT INTO todos (id, sub_account_id, title, due_on, assignee_user_id, contact_id, deal_id, done_at, created_by_user_id) VALUES
         ('td-late',  $1, 'Send the revised quote',  '${isoDay(2)}',  $2,      'ct-pieter', 'd-deck',   NULL,      $2),
         ('td-today', $1, 'Call Amara about tiles',  '${isoDay(0)}',  $2,      'ct-amara',  'd-roof',   NULL,      $2),
         ('td-sam',   $1, 'Order paving stone',      '${isoDay(0)}',  'u-sam', 'ct-ben',    'd-paving', NULL,      $2),
         ('td-done',  $1, 'Book the crane',          '${isoDay(1)}',  $2,      NULL,        'd-paving', ${day(1)}, $2)`,
      [sub.id, owner.id]
    );

    /* Two invoices on the paving job: one paid, one overdue and unpaid. */
    await db.query(
      `INSERT INTO documents (id, sub_account_id, deal_id, kind, number, status, party, party_contact_id, issued_on, due_on, sent_at) VALUES
         ('inv-paid', $1, 'd-paving', 'invoice', 'INV-1001', 'paid', 'Ben Cole', 'ct-ben', (${day(20)})::date, (${day(13)})::date, ${day(20)}),
         ('inv-due',  $1, 'd-paving', 'invoice', 'INV-1002', 'sent', 'Ben Cole', 'ct-ben', (${day(12)})::date, (${day(5)})::date,  ${day(12)})`,
      [sub.id]
    );
    await db.query(
      `INSERT INTO document_lines (id, sub_account_id, document_id, description, quantity, unit_cents, position) VALUES
         ('dl-paid', $1, 'inv-paid', 'Paving — deposit',  1, 2000000, 0),
         ('dl-due',  $1, 'inv-due',  'Paving — phase 1',  1, 1500000, 0)`,
      [sub.id]
    );
    await db.query(
      `INSERT INTO invoice_payments (id, sub_account_id, document_id, provider, reference, amount_cents, currency, paid_at)
       VALUES ('pay-1', $1, 'inv-paid', 'paystack', 'yc_inv-paid_000000000001', 2000000, 'ZAR', ${day(19)})`,
      [sub.id]
    );

    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }

  const rand = (n: number) => `R${n.toLocaleString("en-ZA")}`;
  const wonTotal = DEALS.won_roof + DEALS.won_fence + DEALS.delivery_paving;
  const openTotal = DEALS.prospect_deck + DEALS.discovery_garage + DEALS.demo_solar;
  console.log(`Seeded the demo workspace (${sub.id}), currency ZAR.

  What the screens should show, worked out from the fixture:
    Won revenue (all time)   ${rand(wonTotal)}      ${DEALS.won_roof} + ${DEALS.won_fence} + ${DEALS.delivery_paving}
    Won deals                3
    Open pipeline            ${rand(openTotal)}      ${DEALS.prospect_deck} + ${DEALS.discovery_garage} + ${DEALS.demo_solar}
    Win rate (all time)      75%           3 won / (3 won + 1 lost)
    Average won deal         ${rand(Math.round(wonTotal / 3))}    ${wonTotal} / 3
    Contacts                 6             3 clients, 3 leads
    Inbox unread             2
    Tasks due (today + late) 3             1 late, 2 today
    Tickets open             1             overdue, urgent
    Invoices                 2             INV-1001 paid, INV-1002 overdue
`);
  await db.end();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
