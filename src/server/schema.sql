-- Re-running this file must be safe.
--
-- Everything here is idempotent: tables and indexes use IF NOT EXISTS, triggers
-- and policies are dropped first. `CREATE POLICY` has no IF NOT EXISTS of its
-- own, and a second application failed halfway through — leaving the schema
-- partly updated at precisely the moment somebody was trying to bring it up to
-- date. A migration you cannot re-run is one you cannot recover with.
-- ---------------------------------------------------------------------------
-- YourCRM — multi-tenant schema
--
-- Replaces `crm_collections(name TEXT PRIMARY KEY, data JSONB)`, which held one
-- row per entity type for the ENTIRE system. Every customer's contacts would
-- have shared a single JSONB array in a single row, which made three things
-- impossible at once:
--
--   * tenant isolation could not be enforced by the database — there was no
--     `WHERE tenant_id = $1` to write, only application-level filtering of a
--     shared array, where one missed filter leaks every customer at once;
--   * every write serialised across all customers, because `mutateTable` takes
--     an advisory lock per collection name;
--   * every read loaded every tenant's data to render one tenant's page.
--
-- THREE LEVELS, because the pricing model sells sub-accounts and rebilling:
--
--   agency        the paying customer — subscribes to Starter/Unlimited/SaaS Pro
--     └ sub_account   the agency's own client (3 on Starter, unlimited above)
--         └ CRM data  contacts, leads, deals, meetings, messages, ...
--
-- CRM data hangs off `sub_account_id`, never `agency_id`. The agency's own
-- workspace is simply its first sub-account, so "show me across all my clients"
-- is an ordinary join rather than a special case, and handing a sub-account to
-- someone else is a row update rather than a migration.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Level 1 — the paying customer
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agencies (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,

  -- Billing lives here and only here. Sub-accounts never hold a Stripe
  -- customer of ours; on SaaS Pro the agency bills them itself.
  plan            TEXT NOT NULL DEFAULT 'starter'
                    CHECK (plan IN ('starter', 'unlimited', 'saas_pro')),
  plan_status     TEXT NOT NULL DEFAULT 'trialing'
                    CHECK (plan_status IN ('trialing', 'active', 'past_due', 'canceled')),
  trial_ends_at   TIMESTAMPTZ,
  stripe_customer_id     TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,

  -- Whether agency-wide users may read their sub-accounts' CRM data. TRUE is
  -- the norm for an agency platform and is what rebilling assumes; it exists as
  -- a column so selling to regulated clients later is a policy change rather
  -- than a schema rewrite.
  can_access_sub_account_data BOOLEAN NOT NULL DEFAULT TRUE,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- Level 2 — the agency's clients. All CRM data belongs to one of these.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sub_accounts (
  id          TEXT PRIMARY KEY,
  agency_id   TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,

  -- Exactly one per agency is its own workspace. Enforced by the partial
  -- unique index below rather than by convention.
  is_primary  BOOLEAN NOT NULL DEFAULT FALSE,

  -- The number the voice agent answers on for this client.
  --
  -- A telephony webhook arrives with no session, so nothing about the request
  -- says whose CRM the call belongs to. The dialled number is the only thing
  -- that does. Unique, because two sub-accounts sharing a number would make
  -- every inbound call ambiguous — and the failure looks like somebody else's
  -- customer quietly appearing in your account.
  phone_number TEXT UNIQUE,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS sub_accounts_agency_idx ON sub_accounts (agency_id);
CREATE UNIQUE INDEX IF NOT EXISTS sub_accounts_one_primary
  ON sub_accounts (agency_id) WHERE is_primary;

-- ---------------------------------------------------------------------------
-- Level 3 — people
--
-- `sub_account_id IS NULL` means agency-wide access; a value scopes the user to
-- one client. Email is unique per agency, not globally: the same person may
-- legitimately work for two agencies.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  agency_id       TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  sub_account_id  TEXT REFERENCES sub_accounts(id) ON DELETE CASCADE,

  name            TEXT NOT NULL,
  email           TEXT NOT NULL,
  password_hash   TEXT NOT NULL,

  -- Unlike the old `role`, which was stored, displayed, and never once read for
  -- a decision, this one is enforced.
  --
  -- Ordered here the way the matrix ranks them, most powerful first, because
  -- `ROLES` in tenant.ts is read in that order to decide which roles somebody
  -- may hand out and which is the least privileged. The two lists are pinned
  -- together by a test — this pair had already drifted once, and nothing caught
  -- it until a real INSERT failed.
  role            TEXT NOT NULL DEFAULT 'member'
                    CHECK (role IN ('owner', 'admin', 'finance', 'member')),

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS users_agency_idx ON users (agency_id);

-- Replaces `users_email_per_agency`, which was unique on (agency_id, email) and
-- had two problems.
--
-- Sign-in identifies an account by email ALONE — there is no agency hint on the
-- login form — so per-agency uniqueness still allowed two agencies to hold the
-- same address, and the lookup would resolve to whichever row came back first.
-- That can sign somebody into the wrong agency, silently. Global uniqueness is
-- what email-only login actually requires; if the product ever needs one person
-- in two agencies, that is a membership table, not a looser index.
--
-- It also had no `WHERE deleted_at IS NULL`, so a departed user's address stayed
-- taken forever and could never be re-registered.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique
  ON users (lower(email)) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- CRM entities
--
-- Every one carries `sub_account_id NOT NULL` with an index, so the tenant
-- predicate is always indexed rather than a sequential scan under a filter.
-- `deleted_at` gives soft delete everywhere: the audit found hard deletes with
-- no undo and no tombstone, on real customer data.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS contacts (
  id              TEXT PRIMARY KEY,
  sub_account_id  TEXT NOT NULL REFERENCES sub_accounts(id) ON DELETE CASCADE,
  owner_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,

  first_name      TEXT NOT NULL DEFAULT '',
  last_name       TEXT NOT NULL DEFAULT '',
  email           TEXT,
  phone           TEXT,
  company_id      TEXT,                     -- FK added once companies exists
  info            TEXT,
  location        TEXT,

  -- `leads` used to be a separate table holding a duplicate of the same person,
  -- linked to `contacts` only by name matching — so one human could exist twice
  -- with divergent data and nothing reconciled them. A contact is now simply a
  -- person; whether they are a "lead" is DERIVED from having an open deal, and
  -- whether they are a client is derived from having a won one. Nothing about
  -- their sales position is stored here, because stored status is what went
  -- stale in the old model.

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS contacts_tenant_idx ON contacts (sub_account_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS contacts_owner_idx  ON contacts (owner_user_id);

CREATE TABLE IF NOT EXISTS deals (
  id              TEXT PRIMARY KEY,
  sub_account_id  TEXT NOT NULL REFERENCES sub_accounts(id) ON DELETE CASCADE,
  owner_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  contact_id      TEXT REFERENCES contacts(id) ON DELETE SET NULL,

  title           TEXT NOT NULL,
  value_cents     BIGINT NOT NULL DEFAULT 0,   -- integer cents, never floats

  -- Bradley's real process, replacing the stages I invented. `lost` is not one
  -- of his six steps but is required: deals die, and without a terminal losing
  -- state Win Rate is `won / all deals`, which falls every time a lead is added.
  stage           TEXT NOT NULL DEFAULT 'prospect'
                    CHECK (stage IN ('prospect', 'discovery', 'demo', 'won',
                                     'delivery', 'referral', 'lost')),
  lost_reason     TEXT,

  -- Set when the deal enters `won`, cleared when it leaves. Revenue is counted
  -- from this, never from the stage alone.
  won_at          TIMESTAMPTZ,

  -- The mechanic at the centre of the process: pain points are captured in
  -- Discovery and drive what gets shown in the Demo.
  pain_points     JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- How this opportunity arrived. Lived on the old `leads` table, which meant
  -- revenue-by-source had to match a won deal to a lead BY NAME — the audit
  -- found only 4 of 10 matched, and a rename broke the link silently. As a
  -- column on the deal the attribution is exact and cannot drift.
  source          TEXT NOT NULL DEFAULT 'other'
                    CHECK (source IN ('google_ads', 'facebook', 'referral',
                                      'phone_call', 'website', 'outbound', 'other')),

  -- Which contact referred this deal in, closing the loop back to Prospect.
  -- Set when source = 'referral'; drives the referral credit programme.
  -- Partial payments, carried over from the JSONB model rather than dropped.
  -- A deal paid in instalments splits into a won record for what has been paid
  -- and an open one for what is still owed; both share `split_id`, which is how
  -- the remainder knows where to merge back. `split_total_cents` is the original
  -- contract value — without it a £10,000 part-payment is indistinguishable from
  -- a £10,000 deal paid in full.
  split_id        TEXT,
  split_total_cents BIGINT,

  referred_by_contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS deals_tenant_idx ON deals (sub_account_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS deals_stage_idx  ON deals (sub_account_id, stage) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS deals_split_idx  ON deals (sub_account_id, split_id) WHERE split_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS deals_source_idx ON deals (sub_account_id, source) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Row-Level Security
--
-- The audit's central lesson was that a guard which *can* be forgotten
-- eventually is: 31 server actions were written without an authorisation check
-- and shipped to production. Application-level filtering is exactly that kind
-- of guard. RLS removes the possibility rather than relying on discipline —
-- the database will not return another tenant's row even if a query forgets to
-- ask.
--
-- `app.sub_account_id` is set per transaction by the connection wrapper.
-- ---------------------------------------------------------------------------
-- ENABLE alone is not enough. Postgres exempts a table's OWNER from row-level
-- security, and this application connects as the owner of its own schema. With
-- ENABLE only, every policy below is present, every schema test passes, and no
-- isolation is actually enforced at runtime — the failure is completely silent
-- and would only surface as one customer reading another's records. FORCE
-- applies the policies to the owner too, which is the whole point of having
-- them. Never add one without the other.
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts  FORCE ROW LEVEL SECURITY;
ALTER TABLE deals    ENABLE ROW LEVEL SECURITY;
ALTER TABLE deals     FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contacts_tenant_isolation ON contacts;
CREATE POLICY contacts_tenant_isolation ON contacts
  USING (sub_account_id = current_setting('app.sub_account_id', TRUE))
  WITH CHECK (sub_account_id = current_setting('app.sub_account_id', TRUE));

DROP POLICY IF EXISTS deals_tenant_isolation ON deals;
CREATE POLICY deals_tenant_isolation ON deals
  USING (sub_account_id = current_setting('app.sub_account_id', TRUE))
  WITH CHECK (sub_account_id = current_setting('app.sub_account_id', TRUE));

-- ---------------------------------------------------------------------------
-- Companies
--
-- Was a bare `company` string on each contact, so you could not see every deal
-- for one company and renaming it silently broke the association. A real
-- entity, referenced by id.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS companies (
  id              TEXT PRIMARY KEY,
  sub_account_id  TEXT NOT NULL REFERENCES sub_accounts(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  domain          TEXT,
  info            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS companies_tenant_idx ON companies (sub_account_id) WHERE deleted_at IS NULL;

ALTER TABLE contacts
  DROP CONSTRAINT IF EXISTS contacts_company_fk,
  ADD CONSTRAINT contacts_company_fk
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Meetings
--
-- `scheduled_at` is a real timestamp. The old model stored `when: "Today"` —
-- a rendered label persisted in place of the fact behind it, which was wrong
-- by the next morning and made the calendar unbuildable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meetings (
  id              TEXT PRIMARY KEY,
  sub_account_id  TEXT NOT NULL REFERENCES sub_accounts(id) ON DELETE CASCADE,
  owner_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  contact_id      TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  deal_id         TEXT REFERENCES deals(id) ON DELETE SET NULL,

  topic           TEXT NOT NULL DEFAULT '',
  scheduled_at    TIMESTAMPTZ NOT NULL,
  duration_min    INTEGER NOT NULL DEFAULT 30,
  kind            TEXT NOT NULL DEFAULT 'online' CHECK (kind IN ('online', 'in_person')),
  join_url        TEXT,
  notes           TEXT,

  -- This model was already correct and is kept verbatim: it has a terminal
  -- losing state and a no-show, which is exactly what deals lacked.
  outcome         TEXT NOT NULL DEFAULT 'scheduled'
                    CHECK (outcome IN ('scheduled', 'no_show', 'showed', 'advanced', 'won', 'lost')),
  loss_reason     TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS meetings_tenant_idx ON meetings (sub_account_id, scheduled_at) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Messages, activity, calls
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  sub_account_id  TEXT NOT NULL REFERENCES sub_accounts(id) ON DELETE CASCADE,
  contact_id      TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  direction       TEXT NOT NULL CHECK (direction IN ('received', 'sent')),
  subject         TEXT NOT NULL DEFAULT '',
  body            TEXT NOT NULL DEFAULT '',
  category        TEXT,
  unread          BOOLEAN NOT NULL DEFAULT TRUE,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS messages_tenant_idx ON messages (sub_account_id, sent_at) WHERE deleted_at IS NULL;

-- History for every entity, not just contacts. The audit found the activity
-- trail was keyed to contacts alone, so "what happened to this deal?" could
-- not be answered and stage changes left no trace.
CREATE TABLE IF NOT EXISTS activities (
  id              TEXT PRIMARY KEY,
  sub_account_id  TEXT NOT NULL REFERENCES sub_accounts(id) ON DELETE CASCADE,
  actor_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  entity_type     TEXT NOT NULL CHECK (entity_type IN ('contact', 'deal', 'meeting', 'company')),
  entity_id       TEXT NOT NULL,
  kind            TEXT NOT NULL,
  title           TEXT NOT NULL,
  detail          TEXT,
  amount_cents    BIGINT,
  at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activities_entity_idx ON activities (sub_account_id, entity_type, entity_id, at DESC);

CREATE TABLE IF NOT EXISTS calls (
  id              TEXT PRIMARY KEY,
  sub_account_id  TEXT NOT NULL REFERENCES sub_accounts(id) ON DELETE CASCADE,
  contact_id      TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  created_deal_id TEXT REFERENCES deals(id) ON DELETE SET NULL,
  caller_name     TEXT NOT NULL DEFAULT '',
  phone           TEXT,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_sec    INTEGER NOT NULL DEFAULT 0,
  outcome         TEXT,
  summary         TEXT,
  transcript      JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- What the caller wanted to talk about, and when they asked to meet.
  --
  -- `requested_at` is an INSTANT, not the "Tomorrow" + "10:00 AM" pair the old
  -- model stored. A relative label is only true on the day it was written: a
  -- call logged on Monday asking for "tomorrow" still said tomorrow on Friday,
  -- and the meeting it eventually booked landed four days late. Resolved once,
  -- at capture, in the sub-account's own zone.
  topic           TEXT,
  requested_at    TIMESTAMPTZ,

  -- The meeting this call produced, if it produced one. Together with
  -- `created_deal_id` this is what makes processing idempotent: a call that has
  -- already been turned into records carries the links to them.
  created_meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,

  deleted_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS calls_tenant_idx ON calls (sub_account_id, received_at) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Settings — per sub-account, not global
--
-- `SETTINGS_ID = "workspace"` was a single row for the entire system, so every
-- customer would have shared one monthly target and meeting capacity.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  sub_account_id    TEXT PRIMARY KEY REFERENCES sub_accounts(id) ON DELETE CASCADE,
  monthly_target_cents BIGINT NOT NULL DEFAULT 0,
  weekly_capacity   INTEGER NOT NULL DEFAULT 20,

  -- The zone this business works in.
  --
  -- A booking form submits "2026-03-01" and "14:00" — a wall-clock time with no
  -- zone attached. Turning that into an instant requires knowing which zone was
  -- meant, and reading the SERVER's zone means the same booking lands at a
  -- different moment depending on where it was processed. That is not
  -- hypothetical: it is the defect the data migration rehearsal caught, where
  -- identical input produced 12:00 UTC on a laptop and would have produced
  -- 14:00 UTC on Vercel.
  time_zone         TEXT NOT NULL DEFAULT 'UTC',
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Row-Level Security on every tenant-scoped table
-- ---------------------------------------------------------------------------
ALTER TABLE companies  ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies   FORCE ROW LEVEL SECURITY;
ALTER TABLE meetings   ENABLE ROW LEVEL SECURITY;
ALTER TABLE meetings    FORCE ROW LEVEL SECURITY;
ALTER TABLE messages   ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages    FORCE ROW LEVEL SECURITY;
ALTER TABLE activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE activities  FORCE ROW LEVEL SECURITY;
ALTER TABLE calls      ENABLE ROW LEVEL SECURITY;
ALTER TABLE calls       FORCE ROW LEVEL SECURITY;
ALTER TABLE settings   ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS companies_tenant_isolation ON companies;
CREATE POLICY companies_tenant_isolation ON companies
  USING (sub_account_id = current_setting('app.sub_account_id', TRUE))
  WITH CHECK (sub_account_id = current_setting('app.sub_account_id', TRUE));

DROP POLICY IF EXISTS meetings_tenant_isolation ON meetings;
CREATE POLICY meetings_tenant_isolation ON meetings
  USING (sub_account_id = current_setting('app.sub_account_id', TRUE))
  WITH CHECK (sub_account_id = current_setting('app.sub_account_id', TRUE));

DROP POLICY IF EXISTS messages_tenant_isolation ON messages;
CREATE POLICY messages_tenant_isolation ON messages
  USING (sub_account_id = current_setting('app.sub_account_id', TRUE))
  WITH CHECK (sub_account_id = current_setting('app.sub_account_id', TRUE));

DROP POLICY IF EXISTS activities_tenant_isolation ON activities;
CREATE POLICY activities_tenant_isolation ON activities
  USING (sub_account_id = current_setting('app.sub_account_id', TRUE))
  WITH CHECK (sub_account_id = current_setting('app.sub_account_id', TRUE));

DROP POLICY IF EXISTS calls_tenant_isolation ON calls;
CREATE POLICY calls_tenant_isolation ON calls
  USING (sub_account_id = current_setting('app.sub_account_id', TRUE))
  WITH CHECK (sub_account_id = current_setting('app.sub_account_id', TRUE));

DROP POLICY IF EXISTS settings_tenant_isolation ON settings;
CREATE POLICY settings_tenant_isolation ON settings
  USING (sub_account_id = current_setting('app.sub_account_id', TRUE))
  WITH CHECK (sub_account_id = current_setting('app.sub_account_id', TRUE));


-- ---------------------------------------------------------------------------
-- Assistant chat
--
-- Tenant-scoped and user-scoped: a conversation belongs to one person inside
-- one sub-account, and two colleagues must never see each other's threads.
--
-- Hard-deleted rather than soft, uniquely in this schema. "Clear chat" is a
-- user asking for their own conversation to be gone, and a tombstone that
-- quietly keeps it would make the button a lie. There is no audit interest in
-- what somebody asked an assistant.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS chat_messages (
  id              TEXT PRIMARY KEY,
  sub_account_id  TEXT NOT NULL REFERENCES sub_accounts(id) ON DELETE CASCADE,
  user_id         TEXT REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text            TEXT NOT NULL DEFAULT '',
  at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_messages_tenant_idx ON chat_messages (sub_account_id, user_id, at);

ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages  FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chat_messages_tenant_isolation ON chat_messages;
CREATE POLICY chat_messages_tenant_isolation ON chat_messages
  USING (sub_account_id = current_setting('app.sub_account_id', TRUE))
  WITH CHECK (sub_account_id = current_setting('app.sub_account_id', TRUE));


-- ---------------------------------------------------------------------------
-- Pre-authentication tables
--
-- These two are deliberately NOT tenant-scoped, and the reason is structural
-- rather than an oversight: both are used before anyone is signed in, so there
-- is no tenant to scope them to. Rate limiting a login has to work for a user
-- whose account we have not identified yet — that is the entire point — and a
-- password reset is requested by someone who cannot authenticate.
--
-- They carry no customer records. A row here is a hash and a counter.
-- ---------------------------------------------------------------------------

-- Only a SHA-256 hash of each token is ever stored. A live reset token IS a
-- credential, so the same rule as passwords applies: if this table leaks, the
-- rows must be useless. Single-use and short-lived; rows are deleted on use or
-- expiry rather than flagged, so the table cannot grow without bound.
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash      TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets (user_id);
CREATE INDEX IF NOT EXISTS password_resets_expiry_idx ON password_resets (expires_at);

-- Keyed `email:someone@example.com` or `ip:1.2.3.4`; the prefix keeps the two
-- namespaces apart so one cannot be spoofed into the other. Persisted rather
-- than held in memory because on a serverless host each request may land on a
-- fresh instance, and an in-process counter would reset constantly and protect
-- nothing.
CREATE TABLE IF NOT EXISTS login_attempts (
  key             TEXT PRIMARY KEY,
  failures        INTEGER NOT NULL DEFAULT 0,
  first_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS login_attempts_lock_idx ON login_attempts (locked_until);


-- ---------------------------------------------------------------------------
-- Ownership must stay inside the tenant
--
-- `owner_user_id REFERENCES users(id)` says the owner is a real user. It does
-- NOT say the owner belongs to this customer, and a foreign key cannot express
-- that: the tenant is on the row, the agency is on the user, and the link
-- between them runs through sub_accounts.
--
-- Verified before this existed: a deal in agency A's sub-account could be
-- assigned to agency B's employee, and the reports layer joins users to show
-- the owner's NAME — so B's staff name rendered on A's report. Row-level
-- security does not catch it, because the write targets a row in A's own tenant
-- and is legitimately allowed; only the value being written is wrong.
--
-- Enforced as a trigger rather than in the repositories alone, for the same
-- reason the policies exist: a rule that only lives in application code is one
-- an import script, a migration or a future endpoint can skip without noticing.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION assert_owner_in_tenant() RETURNS trigger AS $$
BEGIN
  IF NEW.owner_user_id IS NULL THEN
    RETURN NEW;  -- unassigned is always valid
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM users u
    JOIN sub_accounts sa ON sa.id = NEW.sub_account_id
    WHERE u.id = NEW.owner_user_id
      AND u.deleted_at IS NULL
      AND u.agency_id = sa.agency_id
      -- Agency-wide staff (NULL sub_account_id) may own anything in their
      -- agency; someone pinned to one client may only own that client's work.
      AND (u.sub_account_id IS NULL OR u.sub_account_id = NEW.sub_account_id)
  ) THEN
    RAISE EXCEPTION
      'owner % does not belong to sub-account %', NEW.owner_user_id, NEW.sub_account_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS contacts_owner_in_tenant ON contacts;
CREATE TRIGGER contacts_owner_in_tenant
  BEFORE INSERT OR UPDATE OF owner_user_id, sub_account_id ON contacts
  FOR EACH ROW EXECUTE FUNCTION assert_owner_in_tenant();

DROP TRIGGER IF EXISTS deals_owner_in_tenant ON deals;
CREATE TRIGGER deals_owner_in_tenant
  BEFORE INSERT OR UPDATE OF owner_user_id, sub_account_id ON deals
  FOR EACH ROW EXECUTE FUNCTION assert_owner_in_tenant();

DROP TRIGGER IF EXISTS meetings_owner_in_tenant ON meetings;
CREATE TRIGGER meetings_owner_in_tenant
  BEFORE INSERT OR UPDATE OF owner_user_id, sub_account_id ON meetings
  FOR EACH ROW EXECUTE FUNCTION assert_owner_in_tenant();


-- ---------------------------------------------------------------------------
-- In-flight voice sessions
--
-- Scratch state for a call that is happening right now: what the caller has
-- said so far, what the agent has worked out. It lives for the length of the
-- call and is deleted when the call ends.
--
-- Not tenant-scoped, and deliberately so: a telephony webhook arrives before
-- anything has resolved which customer the call belongs to — that resolution
-- reads the dialled number, which happens at the end. Keyed by the provider's
-- own call id, which is unguessable and unique across the platform.
--
-- The last thing still living in `crm_collections`. Moving it here means the
-- application never issues DDL, so it can run as a role with no CREATE
-- privilege on the schema — which is what stops it from being able to bypass
-- row-level security.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS voice_sessions (
  id          TEXT PRIMARY KEY,
  data        JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Abandoned calls leave rows behind — a provider does not always send a final
-- status callback. Indexed so a sweep of stale sessions stays cheap.
CREATE INDEX IF NOT EXISTS voice_sessions_stale_idx ON voice_sessions (updated_at);


-- ---------------------------------------------------------------------------
-- What each plan grants
--
-- Entitlements live in a table, not in `if (plan === "saas_pro")` scattered
-- through the code. A row means the plan is entitled to that feature; no row
-- means it is not. `limit_value` is the cap where one applies and NULL means
-- unlimited — so "3 sub-accounts" and "unlimited sub-accounts" are the same
-- feature with a different number, rather than two branches.
--
-- The point is that changing the pricing is editing rows. A tier that gains a
-- feature should not require finding every place the old tier was named, and
-- the day somebody negotiates a custom plan, that is a row too.
--
-- Seeded below with the published pricing. Deliberately NOT tenant-scoped:
-- these are the product's terms, identical for every customer, and a tenant
-- that could edit its own entitlements would be a tenant that grants itself
-- whatever it likes.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS plan_entitlements (
  plan        TEXT NOT NULL CHECK (plan IN ('starter', 'unlimited', 'saas_pro')),
  feature     TEXT NOT NULL,
  -- NULL means no limit. A number is the cap.
  limit_value INTEGER,
  PRIMARY KEY (plan, feature)
);

-- The published tiers, 17 Aug 2026. Each tier includes everything below it,
-- written out in full rather than inherited: an inheritance rule is one more
-- thing that can be wrong, and there are only three tiers.
INSERT INTO plan_entitlements (plan, feature, limit_value) VALUES
  -- Starter, $97/mo
  ('starter',   'crm',              NULL),
  ('starter',   'pipelines',        NULL),
  ('starter',   'online_booking',   NULL),
  ('starter',   'contacts',         NULL),
  ('starter',   'users',            NULL),
  ('starter',   'sub_accounts',        3),

  -- Unlimited, $297/mo
  ('unlimited', 'crm',              NULL),
  ('unlimited', 'pipelines',        NULL),
  ('unlimited', 'online_booking',   NULL),
  ('unlimited', 'contacts',         NULL),
  ('unlimited', 'users',            NULL),
  ('unlimited', 'sub_accounts',     NULL),
  ('unlimited', 'api_access',       NULL),
  ('unlimited', 'white_label',      NULL),

  -- SaaS Pro, $497/mo
  ('saas_pro',  'crm',              NULL),
  ('saas_pro',  'pipelines',        NULL),
  ('saas_pro',  'online_booking',   NULL),
  ('saas_pro',  'contacts',         NULL),
  ('saas_pro',  'users',            NULL),
  ('saas_pro',  'sub_accounts',     NULL),
  ('saas_pro',  'api_access',       NULL),
  ('saas_pro',  'white_label',      NULL),
  ('saas_pro',  'saas_mode',        NULL),
  ('saas_pro',  'rebilling',        NULL)
ON CONFLICT (plan, feature) DO UPDATE SET limit_value = EXCLUDED.limit_value;

-- ---------------------------------------------------------------------------
-- Billing events
--
-- Stripe delivers at least once, and retries anything that does not return 2xx.
-- The same event WILL arrive twice, and a duplicate must be a no-op rather than
-- a second charge's worth of state change. The event id is the natural key.
--
-- Platform-level, like plan_entitlements: not tenant-scoped, because a webhook
-- arrives before anything has resolved which customer it belongs to — the
-- resolution is what the handler does. It holds Stripe ids and a status, never
-- customer records and never anything from a card.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS stripe_events (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  -- Stripe's own creation time, in seconds. Used to reject an event that is
  -- older than the state already applied: retries and parallel deliveries mean
  -- events do NOT arrive in order, and a delayed `subscription.updated` landing
  -- after a cancellation would resurrect the subscription.
  created_at    TIMESTAMPTZ NOT NULL,
  agency_id     TEXT REFERENCES agencies(id) ON DELETE SET NULL,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stripe_events_agency_idx ON stripe_events (agency_id, created_at DESC);

-- The Stripe event that last wrote this agency's billing columns. An event
-- created before this one is stale and must not be applied.
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS billing_synced_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- When a deal was lost
--
-- A win has always been stamped with `won_at`; a loss was stamped with nothing.
-- That made Win Rate wrong for every period except All time, because the
-- numerator could be filtered to the window and the denominator could not:
-- Reports computed this month's wins against EVERY loss ever recorded. On a
-- fixture with three wins and one loss this month it showed 50% where the truth
-- was 75%, and the error grows with the age of the account — the longer you
-- have been selling, the worse this month looks.
--
-- Backfilled from `updated_at`, which for a deal sitting in `lost` is when it
-- was last changed and therefore, for almost all of them, when it was marked
-- lost. That is an approximation and is only applied to rows that predate this
-- column; everything from here on is stamped at the moment of the transition.
-- The WHERE clause stops matching once it has run, so the migration is
-- re-runnable like the rest of this file.
-- ---------------------------------------------------------------------------
ALTER TABLE deals ADD COLUMN IF NOT EXISTS lost_at TIMESTAMPTZ;

UPDATE deals SET lost_at = updated_at
WHERE stage = 'lost' AND lost_at IS NULL;

CREATE INDEX IF NOT EXISTS deals_lost_at_idx
  ON deals (sub_account_id, lost_at) WHERE lost_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Referral rewards
--
-- An agency that sends another agency to YourCRM earns credit against their own
-- subscription. Credit rather than a discount, deliberately: a discount cuts
-- the price permanently and quietly reduces MRR, while credit is a one-off
-- balance that is spent and gone. The customer gets the same value; the revenue
-- line stays honest about what the product costs.
--
-- Held as a LEDGER, not a running total on the agency. A balance is derived
-- from entries that can each be explained — "where did this £97 come from" has
-- an answer, and an adjustment is a new row rather than an edit that erases
-- what it replaced.
-- ---------------------------------------------------------------------------

ALTER TABLE agencies ADD COLUMN IF NOT EXISTS referral_code TEXT;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS referred_by_agency_id TEXT
  REFERENCES agencies(id) ON DELETE SET NULL;

-- Codes are unique across the platform, since they are how a signup is
-- attributed. Partial, so the many agencies without one do not collide.
CREATE UNIQUE INDEX IF NOT EXISTS agencies_referral_code_key
  ON agencies (referral_code) WHERE referral_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS referral_credits (
  id              TEXT PRIMARY KEY,
  -- Who earned it.
  agency_id       TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  -- Who they referred. Null for a manual adjustment, which is why this is not
  -- NOT NULL — support has to be able to grant or claw back credit.
  from_agency_id  TEXT REFERENCES agencies(id) ON DELETE SET NULL,

  -- Positive earns credit, negative spends or reverses it. One column rather
  -- than an amount plus a direction: a sign cannot disagree with itself.
  amount_cents    BIGINT NOT NULL,
  reason          TEXT NOT NULL,

  -- The Stripe invoice this was earned from, when it came from one. Unique so
  -- a redelivered webhook cannot pay the same referral twice — the same
  -- at-least-once problem the subscription events have.
  stripe_invoice_id TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS referral_credits_agency_idx
  ON referral_credits (agency_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS referral_credits_invoice_key
  ON referral_credits (stripe_invoice_id) WHERE stripe_invoice_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Usage
--
-- What each workspace actually consumes, recorded as it happens.
--
-- The tiers sell "unlimited contacts and users" alongside an AI assistant and
-- inbound telephony, and both of those cost real money per use. Nobody knows
-- how much, because nothing has ever measured it — and a plan priced against a
-- cost nobody has measured is a guess that only shows up as a margin.
--
-- So this MEASURES and does not limit. Deciding a policy before there is a
-- month of data would be inventing the number twice.
--
-- Tenant-scoped: an agency reselling to its clients needs to know which client
-- is generating the cost, not merely that the cost exists. That is also the
-- rebilling input.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS usage_events (
  id              TEXT PRIMARY KEY,
  sub_account_id  TEXT NOT NULL REFERENCES sub_accounts(id) ON DELETE CASCADE,

  kind            TEXT NOT NULL CHECK (kind IN ('ai_message', 'voice_minute', 'sms')),

  -- The unit being counted: messages, minutes, segments. Stored rather than
  -- derived so a change in how cost is calculated cannot rewrite history.
  quantity        NUMERIC(12, 3) NOT NULL DEFAULT 1 CHECK (quantity >= 0),

  -- Micro-cents (1/1,000,000 of a currency unit). A single AI message can cost
  -- a fraction of a cent, and rounding each one to whole cents would report
  -- zero for the first several thousand — the exact figure this table exists
  -- to produce.
  cost_micros     BIGINT NOT NULL DEFAULT 0 CHECK (cost_micros >= 0),

  -- Free-form detail: the model, the provider, the number of tokens. Enough to
  -- recompute a cost later when the rates change, without a schema migration.
  detail          JSONB NOT NULL DEFAULT '{}'::jsonb,

  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_events_tenant_idx ON usage_events (sub_account_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS usage_events_kind_idx ON usage_events (sub_account_id, kind, occurred_at DESC);

ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS usage_events_tenant_isolation ON usage_events;
CREATE POLICY usage_events_tenant_isolation ON usage_events
  USING (sub_account_id = current_setting('app.sub_account_id', TRUE))
  WITH CHECK (sub_account_id = current_setting('app.sub_account_id', TRUE));

-- ---------------------------------------------------------------------------
-- Backfill: turn company names into company rows.
--
-- The name lived in `contacts.info` — the same text repeated on every person
-- who worked there. So there was no way to see every deal for one company, and
-- correcting a spelling on one contact silently detached them from the rest.
--
-- Matched case-insensitively per workspace: "Acme Ltd" and "acme ltd" are one
-- company, and creating both would produce exactly the mess this is fixing.
-- The first spelling encountered wins, because a company whose name changes
-- depending on who was added last is worse than one that is slightly wrong.
--
-- Self-limiting: only contacts with a name in `info` and no `company_id` are
-- touched, so re-applying the schema on every deploy cannot duplicate anything.
-- `info` is deliberately left in place — nothing reads it as the company any
-- more, and clearing it would destroy the only copy if this is ever reverted.
-- ---------------------------------------------------------------------------

INSERT INTO companies (id, sub_account_id, name)
SELECT DISTINCT ON (c.sub_account_id, lower(btrim(c.info)))
       'co-' || substr(md5(c.sub_account_id || lower(btrim(c.info))), 1, 16),
       c.sub_account_id,
       btrim(c.info)
  FROM contacts c
 WHERE c.deleted_at IS NULL
   AND c.company_id IS NULL
   AND btrim(COALESCE(c.info, '')) <> ''
   AND NOT EXISTS (
     SELECT 1 FROM companies co
      WHERE co.sub_account_id = c.sub_account_id
        AND co.deleted_at IS NULL
        AND lower(co.name) = lower(btrim(c.info))
   )
 ORDER BY c.sub_account_id, lower(btrim(c.info)), c.created_at ASC
ON CONFLICT (id) DO NOTHING;

UPDATE contacts c
   SET company_id = co.id
  FROM companies co
 WHERE c.company_id IS NULL
   AND c.deleted_at IS NULL
   AND co.sub_account_id = c.sub_account_id
   AND co.deleted_at IS NULL
   AND lower(co.name) = lower(btrim(COALESCE(c.info, '')))
   AND btrim(COALESCE(c.info, '')) <> '';

-- ---------------------------------------------------------------------------
-- Backfill: give existing trials an end date.
--
-- Signup used to leave `trial_ends_at` NULL, and entitlements only expired a
-- trial that had one — so every account created before 22 Aug 2026 was on a
-- trial that never finished. Both live agencies were in that state.
--
-- Now that an unbounded trial counts as OVER, deploying the fix without this
-- would lock those accounts out on the next request. Fourteen days from the
-- moment this runs, rather than from `created_at`: nobody was ever told their
-- trial had started, so starting the clock retroactively would expire accounts
-- the same day the fix shipped.
--
-- Self-limiting rather than merely idempotent — the WHERE clause stops matching
-- as soon as it has run, so re-applying the schema cannot extend a trial a
-- second time.
-- ---------------------------------------------------------------------------
UPDATE agencies
   SET trial_ends_at = now() + interval '14 days'
 WHERE plan_status = 'trialing'
   AND trial_ends_at IS NULL
   AND deleted_at IS NULL;


-- ---------------------------------------------------------------------------
-- Who each colleague actually is.
--
-- `users` held a name, an email and a permission role, which is everything the
-- software needed and nothing a person needed. The Team screen is meant to be
-- the company directory — every department, who to call, what they are
-- responsible for — and none of that could be stored.
--
-- Four columns, all nullable and all optional. An account that never fills them
-- in shows a name and an email exactly as it does today; nothing on this list
-- is required to sign in, be invited, or own a record.
--
--   department  groups the directory. NULL means "not filed yet", which is a
--               real state on the day somebody joins and is shown as its own
--               group rather than hidden.
--   job_title   what they are, e.g. "Account Executive".
--   phone       how to reach them. Deliberately free text: this is an internal
--               directory, not a dialling target, and an extension like
--               "x204" is a legitimate answer.
--   scope       what they are responsible for, in their own words.
--
-- No CHECK on department. A fixed list of departments would be this product
-- telling a customer how to organise their own company, and the first one to
-- need "Field Ops" would be blocked by a migration.
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS department TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS job_title  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone      TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS scope      TEXT;

-- The directory is read grouped by department, per agency, and every read
-- excludes the people who have left.
CREATE INDEX IF NOT EXISTS users_directory_idx
  ON users (agency_id, department) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- The finance role.
--
-- Billing was owner-only, and owner grants everything else as well. So letting
-- the bookkeeper handle an invoice meant making them an owner — which also let
-- them remove the CEO. That is the wrong shape for a company with an accounts
-- department, and a fourth role is the smallest thing that fixes it.
--
-- `finance` holds `manage_billing` and nothing else. What follows from that is
-- not written anywhere: `outranks` says you may act on somebody only if you
-- hold every capability they hold, so an admin cannot touch a finance user
-- (they do not hold manage_billing) and a finance user cannot touch anybody.
-- Only an owner appoints or removes one.
--
-- The constraint is dropped and recreated rather than altered, because the
-- inline CHECK above only applies to a database being created for the first
-- time. `CREATE TABLE IF NOT EXISTS` does nothing to a table that already
-- exists, so without this an existing deployment would keep the old three-value
-- constraint and reject every finance user with a violation nobody could
-- explain from the application's side.
--
-- Named explicitly rather than relying on Postgres's generated name, so this is
-- re-runnable and says what it is dropping.
-- ---------------------------------------------------------------------------
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('owner', 'admin', 'finance', 'member'));

-- ---------------------------------------------------------------------------
-- A deal belongs to a company, directly.
--
-- Projects are how the work is actually talked about: "Heineken — rebuild
-- warehouse", and then next year another one for the same client. That is what
-- a deal already IS — a title, a value, an owner, a stage that runs through
-- delivery — so this adds no second entity to drift against it. What it adds is
-- the missing edge.
--
-- Until now a deal reached its company only THROUGH a contact. Three ways that
-- fails, all of them ordinary:
--
--   * a deal with no contact yet files under nothing;
--   * a contact with no company does the same;
--   * and the person who introduced the work leaves, the contact is reassigned
--     or deleted, and the deal silently detaches from the client it was for.
--
-- The company is a fact about the work, not about whoever happened to be the
-- point of contact, so it is stored on the work.
--
-- Backfilled from the contact's company, which is where the answer lives today.
-- The WHERE stops matching once it has run, so this file stays re-runnable.
-- ---------------------------------------------------------------------------
ALTER TABLE deals ADD COLUMN IF NOT EXISTS company_id TEXT;

ALTER TABLE deals
  DROP CONSTRAINT IF EXISTS deals_company_fk,
  ADD CONSTRAINT deals_company_fk
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL;

UPDATE deals d
   SET company_id = c.company_id
  FROM contacts c
 WHERE d.contact_id = c.id
   AND d.company_id IS NULL
   AND c.company_id IS NOT NULL;

-- The projects page reads every deal for one company, live ones first.
CREATE INDEX IF NOT EXISTS deals_company_idx
  ON deals (sub_account_id, company_id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- A company reference may not cross a tenant boundary.
--
-- Same hole as `owner_user_id` had, and it was never closed for companies:
-- `company_id` is a foreign key to `companies(id)`, which says the company is a
-- real row and says NOTHING about whose it is. Row level security does not
-- catch it either — the write targets a row in this tenant and is legitimately
-- allowed; only the VALUE is wrong. The result would be one customer's deal
-- filed under another customer's client, and the projects page joins companies
-- to show the NAME, so it would render there.
--
-- Applied to contacts as well as deals. The gap predates this change; adding a
-- second way to reach it was the reason to fix both.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_company_in_tenant() RETURNS trigger AS $$
BEGIN
  IF NEW.company_id IS NULL THEN
    RETURN NEW;  -- unfiled is always valid
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM companies co
     WHERE co.id = NEW.company_id
       AND co.sub_account_id = NEW.sub_account_id
       AND co.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION
      'company % does not belong to sub-account %', NEW.company_id, NEW.sub_account_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS deals_company_in_tenant ON deals;
CREATE TRIGGER deals_company_in_tenant
  BEFORE INSERT OR UPDATE OF company_id, sub_account_id ON deals
  FOR EACH ROW EXECUTE FUNCTION assert_company_in_tenant();

DROP TRIGGER IF EXISTS contacts_company_in_tenant ON contacts;
CREATE TRIGGER contacts_company_in_tenant
  BEFORE INSERT OR UPDATE OF company_id, sub_account_id ON contacts
  FOR EACH ROW EXECUTE FUNCTION assert_company_in_tenant();

-- ---------------------------------------------------------------------------
-- A deal's company FOLLOWS its contact's.
--
-- The design says a deal's company is derived from its contact — no form asks
-- for it, because an answer that can disagree with the contact is worse than
-- no answer. That derivation was only ever applied ONCE, at the moment the
-- deal was created, and nothing applied it again.
--
-- The consequence was the shape of a bug rather than the look of one. Somebody
-- files a contact under a client, correctly, and their existing work stays
-- attached to nobody: the Projects page keeps omitting a deal whose contact
-- plainly has a company now, and no screen anywhere explains why. The only
-- remedy was to delete the deal and make it again.
--
-- So the derivation is enforced where it is stated, rather than remembered at
-- each of the several call sites that can move a contact — the edit form, the
-- bulk action on the list, an import, and whatever is added next.
--
-- `updated_at` is deliberately NOT touched. Projects orders clients by when
-- anything last happened to their work, and re-filing is bookkeeping, not
-- activity: bumping it would float a dormant client to the top for a change
-- nobody made to the job itself.
--
-- `sub_account_id` in the UPDATE below is redundant, and kept deliberately.
-- Mutation testing says so plainly: removing it breaks no test, because a
-- contact id is unique across the platform and no deal in another workspace
-- can reference this one. It stays because it costs nothing, it lets the
-- tenant index serve the statement, and a reader should not have to re-derive
-- that argument every time. Nothing rests on it — so nothing should be added
-- that does.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION deals_follow_contact_company() RETURNS trigger AS $$
BEGIN
  UPDATE deals SET company_id = NEW.company_id
   WHERE contact_id = NEW.id
     AND sub_account_id = NEW.sub_account_id
     AND deleted_at IS NULL
     AND company_id IS DISTINCT FROM NEW.company_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS contacts_company_flows_to_deals ON contacts;
CREATE TRIGGER contacts_company_flows_to_deals
  AFTER UPDATE OF company_id ON contacts
  FOR EACH ROW
  WHEN (OLD.company_id IS DISTINCT FROM NEW.company_id)
  EXECUTE FUNCTION deals_follow_contact_company();

-- Existing rows, once. Every deal whose contact is filed but which is not:
-- exactly the work that was stranded before the trigger existed.
UPDATE deals d SET company_id = c.company_id
  FROM contacts c
 WHERE c.id = d.contact_id
   AND c.sub_account_id = d.sub_account_id
   AND c.deleted_at IS NULL
   AND d.deleted_at IS NULL
   AND d.company_id IS NULL
   AND c.company_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- A project is a job at a place, on a timescale.
--
-- "Heineken — rebuild warehouse" was enough to list the work. "Heineken
-- Stellenbosch" is how people actually say it, because the same client has the
-- same kind of job at more than one site, and telling two of them apart by
-- title alone means retyping the site into every title and hoping everyone
-- spells it the same way. Same argument as company names living in a text
-- column, one level down.
--
-- Dates because a project without a deadline cannot be managed, only observed.
-- Both nullable: work often starts before anybody agrees when it ends.
-- ---------------------------------------------------------------------------
ALTER TABLE deals ADD COLUMN IF NOT EXISTS site      TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS starts_on DATE;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS due_on    DATE;

-- ---------------------------------------------------------------------------
-- Who is on the job.
--
-- A deal has ONE `contact_id` and ONE `owner_user_id`, which describes a sale:
-- the person buying and the person selling. It does not describe a project,
-- where a site manager, a quantity surveyor, two of your engineers and the
-- client's procurement lead are all on the same thread.
--
-- One table for both sides deliberately. The alternative — a staff table and a
-- client-contact table — means every screen that lists "everyone on this job"
-- does two queries and merges them, and every new question about the team gets
-- asked twice. Exactly one of `user_id` and `contact_id` is set, which the
-- CHECK enforces rather than trusting.
--
-- `role_on_job` is free text on purpose. "Site Manager", "QS", "Client PM" —
-- a fixed list would be this product telling a customer how their industry
-- names its roles, and the first one to need "Clerk of Works" would be blocked
-- by a migration.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_people (
  id              TEXT PRIMARY KEY,
  sub_account_id  TEXT NOT NULL REFERENCES sub_accounts(id) ON DELETE CASCADE,
  deal_id         TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,

  -- Exactly one of these. Your colleague, or their person.
  user_id         TEXT REFERENCES users(id) ON DELETE CASCADE,
  contact_id      TEXT REFERENCES contacts(id) ON DELETE CASCADE,
  CONSTRAINT project_people_one_side
    CHECK ((user_id IS NULL) <> (contact_id IS NULL)),

  role_on_job     TEXT,
  added_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Somebody is on a job once. Two partial indexes rather than one over both
-- columns, because NULLs do not compare equal and a single index would happily
-- allow the same person twice.
CREATE UNIQUE INDEX IF NOT EXISTS project_people_user_once
  ON project_people (deal_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS project_people_contact_once
  ON project_people (deal_id, contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS project_people_deal_idx ON project_people (sub_account_id, deal_id);

ALTER TABLE project_people ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_people FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS project_people_tenant_isolation ON project_people;
CREATE POLICY project_people_tenant_isolation ON project_people
  USING (sub_account_id = current_setting('app.sub_account_id', TRUE))
  WITH CHECK (sub_account_id = current_setting('app.sub_account_id', TRUE));

-- ---------------------------------------------------------------------------
-- Quotations, purchase orders — and, shortly, invoices.
--
-- One table with a `kind`, not three tables. They are the same shape: a
-- numbered document, issued to somebody on a date, with lines that add up and a
-- status that moves. Modelling them separately would triple every query that
-- asks "what is this project committed to" and guarantee the three drift.
--
-- `invoice` is in the CHECK from the start even though nothing issues one yet.
-- Adding a value to a CHECK later is a migration; leaving room in it is free,
-- and the next feature is billing.
--
-- Money is never stored on this row. A total that is both stored and derivable
-- is two answers to one question, and the stored one goes stale the moment a
-- line is edited. Totals come from `document_lines`, summed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS documents (
  id              TEXT PRIMARY KEY,
  sub_account_id  TEXT NOT NULL REFERENCES sub_accounts(id) ON DELETE CASCADE,
  deal_id         TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,

  kind            TEXT NOT NULL
                    CHECK (kind IN ('quote', 'purchase_order', 'invoice')),

  -- What the customer calls it: "Q-1042", "PO-88". Theirs to choose, because
  -- it has to match whatever their accounts department already uses.
  number          TEXT NOT NULL,

  -- A quote goes out, comes back accepted or declined. A purchase order is
  -- sent and fulfilled. One list covers both; the UI shows the ones that make
  -- sense for the kind.
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'sent', 'accepted', 'declined',
                                      'paid', 'cancelled')),

  -- Who it is to or from: the client for a quote, the supplier for a PO.
  party           TEXT,
  issued_on       DATE,
  due_on          DATE,
  notes           TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

-- A number is unique within a kind, per workspace. Two quotes both called
-- Q-1042 is an accounts problem nobody wants to untangle later.
CREATE UNIQUE INDEX IF NOT EXISTS documents_number_once
  ON documents (sub_account_id, kind, lower(number)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS documents_deal_idx ON documents (sub_account_id, deal_id) WHERE deleted_at IS NULL;

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS documents_tenant_isolation ON documents;
CREATE POLICY documents_tenant_isolation ON documents
  USING (sub_account_id = current_setting('app.sub_account_id', TRUE))
  WITH CHECK (sub_account_id = current_setting('app.sub_account_id', TRUE));

-- ---------------------------------------------------------------------------
-- What is actually on the quote.
--
-- `quantity` is NUMERIC, not a float and not an integer. Half a day and 2.5
-- tonnes are both real quantities, and a float would make 0.1 + 0.2 a support
-- ticket about a total being one cent out. NUMERIC in Postgres is exact
-- decimal, which is the only correct choice for anything that is multiplied by
-- money.
--
-- The line total is ROUND(quantity * unit_cents) — computed, never stored, for
-- the same reason the document has no total column.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS document_lines (
  id              TEXT PRIMARY KEY,
  sub_account_id  TEXT NOT NULL REFERENCES sub_accounts(id) ON DELETE CASCADE,
  document_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,

  description     TEXT NOT NULL,
  quantity        NUMERIC(14, 3) NOT NULL DEFAULT 1,
  unit_cents      BIGINT NOT NULL DEFAULT 0,

  -- The order they were typed in. Without it the lines come back in whatever
  -- order the planner chose, and a quote reads differently every time it loads.
  position        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS document_lines_doc_idx ON document_lines (sub_account_id, document_id, position);

ALTER TABLE document_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS document_lines_tenant_isolation ON document_lines;
CREATE POLICY document_lines_tenant_isolation ON document_lines
  USING (sub_account_id = current_setting('app.sub_account_id', TRUE))
  WITH CHECK (sub_account_id = current_setting('app.sub_account_id', TRUE));

-- ---------------------------------------------------------------------------
-- Email, threaded, and attached to the job.
--
-- `messages` had a contact and nothing else: no project, and no notion of a
-- reply belonging to anything. So "the email thread about the Stellenbosch
-- warehouse" could not be asked for at all.
--
-- `thread_id` is backfilled by normalised subject within a contact, which is
-- what every mail client does — strip the Re:/Fwd: prefixes and group what is
-- left. It is a heuristic and it is applied ONCE, to history; everything new
-- carries a real thread id from the moment it is created. Said plainly because
-- a heuristic presented as a fact is how somebody later trusts it too far.
--
-- The WHERE stops matching once it has run, so this file stays re-runnable.
-- ---------------------------------------------------------------------------
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deal_id   TEXT REFERENCES deals(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS thread_id TEXT;

UPDATE messages m
   SET thread_id = 'th-' || encode(
         sha256(
           (COALESCE(m.contact_id, 'no-contact') || '|' ||
            lower(regexp_replace(m.subject, '^\s*((re|fwd|fw)\s*:\s*)+', '', 'i'))
           )::bytea
         ), 'hex')
 WHERE m.thread_id IS NULL;

CREATE INDEX IF NOT EXISTS messages_thread_idx
  ON messages (sub_account_id, thread_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS messages_deal_idx
  ON messages (sub_account_id, deal_id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- How a message actually reached you.
--
-- The inbox badge showed the CONTACT'S acquisition source — Facebook, Google
-- Ads, Referral — which is a real fact about the person and tells you nothing
-- about the message. Somebody who first found you through Facebook two years
-- ago and has just sent a WhatsApp still showed a Facebook badge, on a screen
-- whose entire question is "what came in and from where".
--
-- Those are two different things and the product now stores both: the source
-- stays on the contact, and the transport lives on the message.
--
-- `email` is the default, and it is the honest one rather than a convenience.
-- Every message that exists today was either composed in this app — whose
-- composer is an email composer, sending through Resend — or logged by hand as
-- correspondence. ADD COLUMN with a DEFAULT fills the existing rows, so the
-- backfill is the default and there is no second statement to keep in step.
--
-- No CHECK value is offered that nothing can produce. `whatsapp` and `sms`
-- appear because somebody records a conversation on one, which the composer
-- now asks for — a channel nothing could ever set would be a badge that never
-- draws and an option that lies about what the product does.
-- ---------------------------------------------------------------------------
ALTER TABLE messages ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'email';

ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_channel_check,
  ADD CONSTRAINT messages_channel_check
    CHECK (channel IN ('email', 'whatsapp', 'sms'));

-- ---------------------------------------------------------------------------
-- What things cost.
--
-- The prerequisite for an agent drafting a quotation, and the reason it is
-- built first: an AI cannot invent prices. Asked to quote a crane it would
-- otherwise produce a number that looks like a price and is not one — the same
-- class of fabrication as the phantom lead, except this one goes to a customer
-- with a total on it.
--
-- With a list, drafting stops being creative and becomes selection: pick the
-- line, multiply by the quantity, show it to a human. Every figure on a
-- generated quote traces back to a row somebody here typed.
--
-- `unit` is free text. "each", "per day", "per m²", "per pallet" — a CHECK
-- would be this product telling a customer how their industry sells things,
-- and the first one to need "per linear metre" would be blocked by a migration.
--
-- `active` rather than deletion for items no longer sold: a withdrawn item must
-- stop being offered on new quotes while the quotes that already cite it keep
-- making sense.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS price_items (
  id              TEXT PRIMARY KEY,
  sub_account_id  TEXT NOT NULL REFERENCES sub_accounts(id) ON DELETE CASCADE,

  name            TEXT NOT NULL,
  description     TEXT,
  unit            TEXT NOT NULL DEFAULT 'each',
  unit_cents      BIGINT NOT NULL DEFAULT 0,
  active          BOOLEAN NOT NULL DEFAULT TRUE,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

-- A rate is never negative. The repository refuses one, but this table is the
-- source of every figure on a generated quotation, and a guarantee that lives
-- only in one code path is a guarantee until somebody writes a second caller.
-- A discount belongs on the quote as a line, not on the rate card as an item.
ALTER TABLE price_items DROP CONSTRAINT IF EXISTS price_items_unit_cents_check;
ALTER TABLE price_items ADD CONSTRAINT price_items_unit_cents_check
  CHECK (unit_cents >= 0);

-- One item per name. Two rows called "Crane hire" at different prices is a
-- question the agent cannot answer and a person should not have to.
CREATE UNIQUE INDEX IF NOT EXISTS price_items_name_once
  ON price_items (sub_account_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS price_items_tenant_idx ON price_items (sub_account_id) WHERE deleted_at IS NULL;

ALTER TABLE price_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS price_items_tenant_isolation ON price_items;
CREATE POLICY price_items_tenant_isolation ON price_items
  USING (sub_account_id = current_setting('app.sub_account_id', TRUE))
  WITH CHECK (sub_account_id = current_setting('app.sub_account_id', TRUE));

-- ---------------------------------------------------------------------------
-- A quotation an agent drafted, waiting for a human to say yes.
--
-- The safety property of the whole feature, expressed in the schema rather than
-- in a code path somebody could forget: a document an AI produced carries
-- `drafted_by_agent`, and nothing may leave for a client until `approved_at` is
-- set. The agent can write and revise; only a person approves.
--
-- `approved_by_user_id` records WHO said yes. "The system sent it" is not an
-- answer anybody wants when a customer queries a price.
--
-- `revision` counts how many times it has been sent back for changes, so the
-- conversation about a quote has a spine and "the version we agreed" means
-- something.
-- ---------------------------------------------------------------------------
ALTER TABLE documents ADD COLUMN IF NOT EXISTS drafted_by_agent    TEXT;

-- WHO it goes to, as a record rather than as a name.
--
-- `party` is display text — "Marius Steyn, Heineken" — and an email address
-- cannot be recovered from it. Resolving the recipient at approval time by
-- matching that string against contacts would mean the address a person
-- approved and the address it was sent to are established by two different
-- pieces of code at two different moments, which is exactly the kind of seam a
-- quotation must not have. The contact is pinned when the quote is drafted, the
-- approval screen shows that person's real address, and the send reads the same
-- row.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS party_contact_id    TEXT REFERENCES contacts(id) ON DELETE SET NULL;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS approved_at         TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS approved_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS sent_at             TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS revision            INTEGER NOT NULL DEFAULT 0;

-- The two states a drafted quote passes through on its way out. Added to the
-- existing CHECK rather than replacing it, so the statuses already in use keep
-- meaning what they meant.
--
-- `approved` earns its place by being a state that really happens: somebody
-- says yes and the email does not go — no address on file, or Resend is not
-- configured, or it returns a 500. Without it the only honest options are to
-- claim the quote was sent when it was not, or to throw the approval away and
-- ask for it again. Approval and despatch are already two columns; they are two
-- statuses for the same reason.
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_status_check;
ALTER TABLE documents ADD CONSTRAINT documents_status_check
  CHECK (status IN ('draft', 'awaiting_approval', 'approved', 'sent', 'accepted',
                    'declined', 'paid', 'cancelled'));

-- ---------------------------------------------------------------------------
-- What a project is actually made of, and how far along each piece is.
--
-- The project screen could say what a job was worth, who was on it and what had
-- been said about it, and could not say what the WORK was. "Rebuild warehouse"
-- is not a plan; the plan is nineteen tasks with dates against them, which is
-- what every schedule Bradley works from looks like — his own 2026 Procedures
-- baseline is a task list with a start, a finish and a percentage on each row.
--
-- Duration is not stored. It is `due_on - starts_on`, and a stored copy would
-- be a second answer to a question the dates already answer — the same rule the
-- documents table follows for totals, and for the same reason: the copy goes
-- stale the first time somebody moves a date.
--
-- `percent_complete` is an integer 0-100 rather than a boolean. A task is
-- routinely half done, and a schedule that can only say "finished" or "not"
-- cannot show the thing a person opens it to see — where the work actually is.
-- `done_at` records WHEN it reached 100, which a percentage cannot: two tasks
-- both at 100 tell you nothing about which one has been sitting finished for a
-- fortnight.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_tasks (
  id               TEXT PRIMARY KEY,
  sub_account_id   TEXT NOT NULL REFERENCES sub_accounts(id) ON DELETE CASCADE,
  deal_id          TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,

  name             TEXT NOT NULL,

  starts_on        DATE,
  due_on           DATE,

  percent_complete INTEGER NOT NULL DEFAULT 0
                     CHECK (percent_complete BETWEEN 0 AND 100),

  -- When it reached 100. Set and cleared by the repository alongside the
  -- percentage, so "finished" and "finished on" cannot disagree.
  done_at          TIMESTAMPTZ,

  -- Who is doing it. A colleague, not a client — a task is our work.
  owner_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,

  -- The order it reads in. Without it the rows come back in whatever order the
  -- planner chose and a schedule reads differently every time it loads, which
  -- is precisely what a schedule must not do.
  position         INTEGER NOT NULL DEFAULT 0,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ
);

-- A finish before its start is a typo, and catching it in the database means it
-- is caught for every writer rather than for the one form that remembers.
ALTER TABLE project_tasks DROP CONSTRAINT IF EXISTS project_tasks_dates_ordered;
ALTER TABLE project_tasks ADD CONSTRAINT project_tasks_dates_ordered
  CHECK (starts_on IS NULL OR due_on IS NULL OR due_on >= starts_on);

CREATE INDEX IF NOT EXISTS project_tasks_deal_idx ON project_tasks (sub_account_id, deal_id, position) WHERE deleted_at IS NULL;

ALTER TABLE project_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_tasks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS project_tasks_tenant_isolation ON project_tasks;
CREATE POLICY project_tasks_tenant_isolation ON project_tasks
  USING (sub_account_id = current_setting('app.sub_account_id', TRUE))
  WITH CHECK (sub_account_id = current_setting('app.sub_account_id', TRUE));

-- A task belongs to a project in THIS tenant. Row-level security already stops
-- the read, and this stops the write — the same guard `assert_company_in_tenant`
-- gives deals and contacts, for the same reason: a rule that lives in one code
-- path is a rule until somebody writes a second caller.
CREATE OR REPLACE FUNCTION assert_task_deal_in_tenant() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.deal_id IS NOT NULL THEN
    PERFORM 1 FROM deals d
     WHERE d.id = NEW.deal_id AND d.sub_account_id = NEW.sub_account_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'deal % does not belong to sub-account %', NEW.deal_id, NEW.sub_account_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS project_tasks_deal_in_tenant ON project_tasks;
CREATE TRIGGER project_tasks_deal_in_tenant
  BEFORE INSERT OR UPDATE OF deal_id, sub_account_id ON project_tasks
  FOR EACH ROW EXECUTE FUNCTION assert_task_deal_in_tenant();

-- ---------------------------------------------------------------------------
-- What a task is waiting on.
--
-- The staircase in every real schedule — each task starting when the one before
-- it finishes — was a shape somebody maintained by hand. Moving one date meant
-- retyping every date below it, and the first one missed is a plan that is
-- quietly wrong in exactly the place people trust it.
--
-- Finish-to-start only, deliberately. It is the relationship every one of those
-- staircases is made of; start-to-start and the rest are real but rare, and
-- three more kinds would triple the scheduling code to serve a case nobody here
-- has yet. The column is absent rather than a `kind` with one value, because a
-- column with one possible value is a decision pretending to be a feature.
--
-- `lag_days` is the gap AFTER the predecessor finishes. Zero means the next
-- task starts on the following working day, which is the staircase. It exists
-- so a deliberate wait — concrete curing, a part on order — survives the
-- cascade instead of being closed up by it.
--
-- A many-to-many table rather than a `predecessor_id` column on the task: a
-- task genuinely can wait on two things, and the moment it does, a single
-- column forces somebody to pick which dependency to record and which to
-- remember.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_task_dependencies (
  id               TEXT PRIMARY KEY,
  sub_account_id   TEXT NOT NULL REFERENCES sub_accounts(id) ON DELETE CASCADE,

  -- The task that waits.
  task_id          TEXT NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
  -- The task it waits for.
  depends_on_id    TEXT NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,

  lag_days         INTEGER NOT NULL DEFAULT 0 CHECK (lag_days >= 0),

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A task cannot wait for itself. The cheapest cycle to draw and the one a
-- double-click will produce, so it is refused by the table rather than by the
-- code that happens to be calling.
ALTER TABLE project_task_dependencies DROP CONSTRAINT IF EXISTS project_task_deps_not_self;
ALTER TABLE project_task_dependencies ADD CONSTRAINT project_task_deps_not_self
  CHECK (task_id <> depends_on_id);

-- One link per pair. Adding the same dependency twice is a double-click, not an
-- intention, and two identical rows would double nothing except the confusion.
CREATE UNIQUE INDEX IF NOT EXISTS project_task_deps_once
  ON project_task_dependencies (sub_account_id, task_id, depends_on_id);
CREATE INDEX IF NOT EXISTS project_task_deps_tenant_idx ON project_task_dependencies (sub_account_id, task_id);
CREATE INDEX IF NOT EXISTS project_task_deps_upstream_idx ON project_task_dependencies (sub_account_id, depends_on_id);

ALTER TABLE project_task_dependencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_task_dependencies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS project_task_dependencies_tenant_isolation ON project_task_dependencies;
CREATE POLICY project_task_dependencies_tenant_isolation ON project_task_dependencies
  USING (sub_account_id = current_setting('app.sub_account_id', TRUE))
  WITH CHECK (sub_account_id = current_setting('app.sub_account_id', TRUE));

-- Both ends belong to this tenant, and to the SAME project.
--
-- The tenant half is the security rule every table here carries. The project
-- half is the one that keeps a schedule meaningful: a task on the Heineken job
-- waiting for a task on somebody else's job would draw a link between two
-- charts and cascade dates across a customer boundary.
CREATE OR REPLACE FUNCTION assert_dependency_within_project() RETURNS TRIGGER AS $$
DECLARE
  task_deal TEXT;
  upstream_deal TEXT;
BEGIN
  SELECT deal_id INTO task_deal FROM project_tasks
   WHERE id = NEW.task_id AND sub_account_id = NEW.sub_account_id;
  SELECT deal_id INTO upstream_deal FROM project_tasks
   WHERE id = NEW.depends_on_id AND sub_account_id = NEW.sub_account_id;

  IF task_deal IS NULL OR upstream_deal IS NULL THEN
    RAISE EXCEPTION 'both tasks must belong to sub-account %', NEW.sub_account_id;
  END IF;
  IF task_deal <> upstream_deal THEN
    RAISE EXCEPTION 'a task can only depend on a task in the same project';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS project_task_deps_within_project ON project_task_dependencies;
CREATE TRIGGER project_task_deps_within_project
  BEFORE INSERT OR UPDATE ON project_task_dependencies
  FOR EACH ROW EXECUTE FUNCTION assert_dependency_within_project();

-- ---------------------------------------------------------------------------
-- The days this workspace does not work.
--
-- Weekends are a rule; holidays are DATA, and they belong to the workspace
-- rather than to this code. A hardcoded list is wrong for every customer in
-- another country and wrong for this one the year a government moves a date —
-- and a wrong holiday is worse than none, because it moves somebody's work for
-- a reason they cannot see.
--
-- So the schedule reads this table and nothing else. `src/server/holidays.ts`
-- can GENERATE a country's dates to fill it, which is a convenience for the
-- person filling the list, not a fact the scheduler trusts on its own.
--
-- `name` is carried so the list reads as a calendar rather than as a column of
-- dates: "why is nothing scheduled on 16 December" has an answer on the screen.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workspace_holidays (
  id              TEXT PRIMARY KEY,
  sub_account_id  TEXT NOT NULL REFERENCES sub_accounts(id) ON DELETE CASCADE,

  on_date         DATE NOT NULL,
  name            TEXT NOT NULL,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One entry per day. Adding a year twice is a double-click, and two rows for
-- Christmas would not close the office twice.
CREATE UNIQUE INDEX IF NOT EXISTS workspace_holidays_once ON workspace_holidays (sub_account_id, on_date);
CREATE INDEX IF NOT EXISTS workspace_holidays_tenant_idx ON workspace_holidays (sub_account_id, on_date);

ALTER TABLE workspace_holidays ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_holidays FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_holidays_tenant_isolation ON workspace_holidays;
CREATE POLICY workspace_holidays_tenant_isolation ON workspace_holidays
  USING (sub_account_id = current_setting('app.sub_account_id', TRUE))
  WITH CHECK (sub_account_id = current_setting('app.sub_account_id', TRUE));

-- ---------------------------------------------------------------------------
-- Every tool an agent ran, and the reason a retry cannot run it twice.
--
-- One table for the audit trail AND the idempotency record, deliberately. They
-- answer the same question — "did this already happen, and what came of it" —
-- and two tables would be two places to write and one place to forget, with the
-- failure showing up as a duplicate meeting in somebody's calendar.
--
-- `idempotency_key` is composed by the caller from tenant + call + tool + a
-- logical action id, so the same intent retried after a dropped WebSocket or a
-- redelivered webhook resolves to this row instead of acting again. The unique
-- index is what actually enforces it; the code turns the collision into a
-- replay of `result`.
--
-- `result` holds the authoritative answer so a replay returns what the first
-- execution returned rather than a fresh guess. It can contain customer data
-- and so lives here, inside row-level security, and never in the application
-- log — the log records that a tool ran, never what it said.
--
-- `refused` is a first-class outcome, not a failure. An agent asking for
-- something it has no permission to do is a thing we want counted and
-- reviewable, and lumping it in with 'failed' would hide an attack behind a
-- column of timeouts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_tool_executions (
  id               TEXT PRIMARY KEY,
  sub_account_id   TEXT NOT NULL REFERENCES sub_accounts(id) ON DELETE CASCADE,

  -- Which conversation asked. Null when a tool is run outside a call.
  call_id          TEXT,

  tool_name        TEXT NOT NULL,

  -- The human the agent acted as. An agent is never its own authority: its
  -- permissions are a subset of a real person's, and this is that person.
  actor_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,

  -- Which agent surface asked — 'voice' or 'chat'.
  agent            TEXT NOT NULL DEFAULT 'voice',

  status           TEXT NOT NULL
                     CHECK (status IN ('succeeded', 'failed', 'refused')),

  -- Why, in one line, for a person reading the trail. Never record contents.
  detail           TEXT,

  result           JSONB,

  idempotency_key  TEXT NOT NULL,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The guarantee. A second attempt at the same logical action collides here and
-- is answered from the first one's result.
CREATE UNIQUE INDEX IF NOT EXISTS agent_tool_executions_once ON agent_tool_executions (sub_account_id, idempotency_key);
CREATE INDEX IF NOT EXISTS agent_tool_executions_call_idx ON agent_tool_executions (sub_account_id, call_id, created_at);

ALTER TABLE agent_tool_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_tool_executions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_tool_executions_tenant_isolation ON agent_tool_executions;
CREATE POLICY agent_tool_executions_tenant_isolation ON agent_tool_executions
  USING (sub_account_id = current_setting('app.sub_account_id', TRUE))
  WITH CHECK (sub_account_id = current_setting('app.sub_account_id', TRUE));

-- ---------------------------------------------------------------------------
-- What a model concluded from a call, and the words it concluded it from.
--
-- Separate from `calls` on purpose. The call row is the FACT — it happened, it
-- lasted this long, this was said. The analysis is an INTERPRETATION, produced
-- by a model, revisable, and occasionally wrong. Storing a machine's opinion in
-- the same columns as the record of the event makes the two indistinguishable
-- six months later, which is exactly when somebody asks "did the customer
-- actually say that".
--
-- `findings` holds the extracted items, and every one of them carries the
-- transcript line it came from. That is the spec's evidence-linking
-- requirement, and it is what makes an AI-made CRM change reviewable rather
-- than merely auditable: you can read the sentence the claim rests on.
--
-- One analysis per call. Re-running replaces it rather than accumulating
-- opinions, which keeps the post-call pipeline safely retryable — the spec's
-- requirement that analysing twice must not produce two of anything.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS call_analysis (
  call_id          TEXT PRIMARY KEY REFERENCES calls(id) ON DELETE CASCADE,
  sub_account_id   TEXT NOT NULL REFERENCES sub_accounts(id) ON DELETE CASCADE,

  -- What the caller wanted, in the vocabulary the CRM already uses.
  intent           TEXT,
  -- A sentence a person can read without opening the transcript.
  summary          TEXT NOT NULL DEFAULT '',

  -- Extracted items, each with the quoted line it rests on.
  findings         JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- How much of what the model claimed survived verification against the
  -- transcript, 0-100. Low means it was inventing, and the screen says so.
  grounding        INTEGER NOT NULL DEFAULT 0
                     CHECK (grounding BETWEEN 0 AND 100),

  -- Advisory only, per the specification. Never used to drive a decision.
  sentiment        TEXT,

  model            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS call_analysis_tenant_idx ON call_analysis (sub_account_id, created_at);

ALTER TABLE call_analysis ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_analysis FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS call_analysis_tenant_isolation ON call_analysis;
CREATE POLICY call_analysis_tenant_isolation ON call_analysis
  USING (sub_account_id = current_setting('app.sub_account_id', TRUE))
  WITH CHECK (sub_account_id = current_setting('app.sub_account_id', TRUE));

-- ---------------------------------------------------------------------------
-- The transactional outbox
--
-- Work that must happen AFTER a change is committed, exactly once, and must
-- survive the process dying in between.
--
-- The problem it solves is specific. Sending a quotation used to be: POST to
-- the mail provider, then mark the quote sent. Those are two systems and one
-- of them can fail after the other succeeded — so a crash in the gap left a
-- customer holding a quotation the CRM still believed was unsent, and the
-- button to send it still on screen. Enqueueing here instead makes the row and
-- the mutation part of the SAME transaction: either both happened or neither
-- did, and the delivery is retried until it lands.
--
-- Delivery is AT LEAST ONCE, never exactly once — a worker that dies between
-- the provider accepting the request and this row being settled will try
-- again. So every handler must be idempotent, and the ones that talk to an
-- external service pass this row's id as the provider's idempotency key.
--
-- It holds IDS AND A HANDLER NAME, never content: no addresses, no prices, no
-- transcripts. The handler re-reads the record inside a tenant-scoped
-- transaction when it runs, which is both safer and more correct — the row it
-- acts on is the one that exists now, not a copy of what was true when the
-- job was queued.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS outbox (
  id               TEXT PRIMARY KEY,
  sub_account_id   TEXT NOT NULL REFERENCES sub_accounts(id) ON DELETE CASCADE,

  -- Which handler runs this. Not a CHECK constraint: a handler added in a new
  -- deployment must not fail a write against a database migrated a minute
  -- earlier, and an unknown name is already refused in application code where
  -- rejecting is cheap. Same reasoning as `activities.kind`.
  handler          TEXT NOT NULL,

  -- Ids only. See the note above.
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Optional. Two enqueues sharing one means the second is the same job, not a
  -- second copy of it — which is what stops a double-pressed button, a retried
  -- webhook or a replayed call from queueing the same email twice.
  dedupe_key       TEXT,

  -- `dead` rather than `failed`: a failed ATTEMPT is not terminal and leaves
  -- the row pending. This status means we have stopped trying and a person has
  -- to look.
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'done', 'dead')),

  attempts         INTEGER NOT NULL DEFAULT 0,

  -- When it may next be tried. Backoff is written here rather than computed at
  -- read time so a stuck job cannot be picked up in a tight loop by two
  -- workers disagreeing about the current time.
  run_after        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The last failure, for the person who has to look at a dead row. Never the
  -- payload of the request, which is how error logs end up holding the data
  -- the table was careful not to store.
  last_error       TEXT,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at       TIMESTAMPTZ
);

-- Dedupe within a workspace and handler. Partial, because most jobs have no
-- natural key and must not collide with each other on NULL.
CREATE UNIQUE INDEX IF NOT EXISTS outbox_dedupe_key
  ON outbox (sub_account_id, handler, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- The claim query's index: pending work that is due, oldest first. Partial, so
-- it stays small as settled rows accumulate.
CREATE INDEX IF NOT EXISTS outbox_ready_idx
  ON outbox (sub_account_id, run_after) WHERE status = 'pending';

-- And a plain one for every other read.
--
-- The partial index above covers the hot path and, by definition, nothing else:
-- listing the jobs that were given up on filters `status = 'dead'`, which that
-- index excludes. Without this, the one query a person runs when something has
-- gone wrong is the one doing a sequential scan.
CREATE INDEX IF NOT EXISTS outbox_tenant_idx ON outbox (sub_account_id, created_at DESC);

ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS outbox_tenant_isolation ON outbox;
CREATE POLICY outbox_tenant_isolation ON outbox
  USING (sub_account_id = current_setting('app.sub_account_id', TRUE))
  WITH CHECK (sub_account_id = current_setting('app.sub_account_id', TRUE));

-- ---------------------------------------------------------------------------
-- Which stage of the job a document line is for.
--
-- A project had documents and it had a timeline, and nothing joined them. The
-- Documents tab was one flat list for the whole job, so "what paperwork covers
-- the crane hire" had no answer, and a stage could not show what had been
-- quoted for it or ordered against it.
--
-- The link is on the LINE rather than the document, and that is the whole
-- design. A client quotation covers every stage at once — five lines, five
-- stages — so a document-level link could only ever describe purchase orders.
-- A line is the smallest thing that belongs to exactly one piece of work, and
-- from it everything else is derived: a document belongs to the stages its
-- lines point at, and a stage's margin is what its quote lines charge minus
-- what its order lines commit.
--
-- One column also carries PROVENANCE for free. When a plan is built from a
-- quotation each line records the task it became, so a stage can say where it
-- came from without a second link pointing the other way.
--
-- `ON DELETE SET NULL`, never CASCADE: a quote line is a financial record of
-- what a client was charged. Deleting a task from a plan must not delete the
-- money it was quoted at.
-- ---------------------------------------------------------------------------

ALTER TABLE document_lines ADD COLUMN IF NOT EXISTS project_task_id TEXT
  REFERENCES project_tasks(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS document_lines_task_idx
  ON document_lines (sub_account_id, project_task_id) WHERE project_task_id IS NOT NULL;

-- A line may only point at a task on the SAME project, in the same workspace.
--
-- Row-level security does not catch this and could not: the write targets a row
-- in this tenant and is legitimately allowed — only the VALUE is wrong. The
-- result would be one project's costs counted against another's margin, or one
-- customer's stage names appearing in another's document list. The same shape
-- as the company guard above, for the same reason.
CREATE OR REPLACE FUNCTION assert_line_task_in_project() RETURNS TRIGGER AS $$
DECLARE
  line_deal TEXT;
  task_deal TEXT;
BEGIN
  IF NEW.project_task_id IS NULL THEN
    RETURN NEW;  -- a line that belongs to no stage is always valid
  END IF;

  SELECT d.deal_id INTO line_deal FROM documents d
   WHERE d.id = NEW.document_id AND d.sub_account_id = NEW.sub_account_id;

  SELECT t.deal_id INTO task_deal FROM project_tasks t
   WHERE t.id = NEW.project_task_id AND t.sub_account_id = NEW.sub_account_id;

  IF task_deal IS NULL THEN
    RAISE EXCEPTION 'task % does not belong to sub-account %',
      NEW.project_task_id, NEW.sub_account_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF line_deal IS DISTINCT FROM task_deal THEN
    RAISE EXCEPTION 'task % is on a different project from document %',
      NEW.project_task_id, NEW.document_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS document_lines_task_in_project ON document_lines;
CREATE TRIGGER document_lines_task_in_project
  BEFORE INSERT OR UPDATE OF project_task_id, document_id, sub_account_id ON document_lines
  FOR EACH ROW EXECUTE FUNCTION assert_line_task_in_project();

-- ---------------------------------------------------------------------------
-- How a client is meant to pay.
--
-- An invoice without payment details is a demand with no way to satisfy it —
-- the recipient has to ring up and ask, which is exactly the friction an
-- invoice exists to remove. Bank details, a reference format, terms: whatever
-- this business actually puts at the foot of theirs.
--
-- Free text on purpose. Every country and every bank names these fields
-- differently — sort code, routing number, IBAN, branch code — and a structured
-- form would either be wrong for most of the world or so general that it is a
-- text box with extra steps. It is printed as typed, so it is also the one
-- place a business can put its VAT number or its terms.
--
-- On `settings`, not on the document: it is the same for every invoice this
-- workspace raises, and copying it onto each one would mean changing bank
-- accounts required editing history.
-- ---------------------------------------------------------------------------
ALTER TABLE settings ADD COLUMN IF NOT EXISTS invoice_pay_to TEXT;

-- ---------------------------------------------------------------------------
-- Whether an outgoing message was actually transmitted.
--
-- The Inbox composer wrote a row with `direction = 'sent'` and transmitted
-- nothing. There was no mail provider anywhere in the feature: somebody typed
-- a message, pressed send, watched it appear in Sent, and the recipient
-- received nothing. That is the worst thing this product has done, because
-- every Call / Text / Email control across Contacts and Projects funnels into
-- that composer.
--
-- `direction` says which way a message went. This says whether WE sent it, and
-- the two are not the same question:
--
--   NULL      inbound — the question does not apply
--   logged    recorded, never transmitted by us. A phone call, a WhatsApp sent
--             from somebody's own handset, or anything written before this
--             column existed.
--   queued    handed to the outbox and not yet away
--   sent      the provider accepted it
--   failed    it was tried and given up on; `delivery_error` says why
--
-- EVERY EXISTING OUTBOUND ROW BECOMES `logged`, because that is the truth
-- about them: they were records of correspondence, not correspondence. Marking
-- them `sent` would be the same lie in a new column.
-- ---------------------------------------------------------------------------

ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivery       TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivery_error TEXT;

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_delivery_known;
ALTER TABLE messages ADD CONSTRAINT messages_delivery_known
  CHECK (delivery IS NULL OR delivery IN ('logged', 'queued', 'sent', 'failed'));

UPDATE messages SET delivery = 'logged'
 WHERE direction = 'sent' AND delivery IS NULL;

CREATE INDEX IF NOT EXISTS messages_delivery_idx
  ON messages (sub_account_id, delivery) WHERE delivery IS NOT NULL;
