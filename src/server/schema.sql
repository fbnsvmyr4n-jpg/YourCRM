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
  role            TEXT NOT NULL DEFAULT 'member'
                    CHECK (role IN ('owner', 'admin', 'member')),

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
  referred_by_contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS deals_tenant_idx ON deals (sub_account_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS deals_stage_idx  ON deals (sub_account_id, stage) WHERE deleted_at IS NULL;
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

