# YourCRM

A full CRM — contacts, leads, a drag-and-drop deals pipeline, meetings with
outcome tracking, a calendar, an inbox, live reports, and two agents (a
CRM-aware chat assistant and a voice agent that turns calls into leads and
booked meetings).

Every figure on screen is computed from persisted records. Where the data
can't answer a question, the UI says so ("—", "No revenue yet") rather than
showing a plausible placeholder.

---

## Running locally

Requires Node 20+.

```bash
npm install
npm run dev
```

Open <http://localhost:3000> and sign in with the seeded demo account:

```
demo@yourcrm.com / demo1234
```

No configuration is needed for local development: data goes to JSON files
under `.data/`, and the session cookie is signed with a built-in dev key.
**Neither is safe in production** — see below.

> The dev and build scripts pass `--webpack` deliberately. Turbopack fails on
> this project's path, which contains a space.

To reset all demo data back to its seeded state:

```bash
rm -rf .data
```

---

## Deploying

Two environment variables are required. The app **refuses to serve without
them** in production rather than starting in an unsafe state — both failure
modes below are otherwise completely silent.

### 1. `DATABASE_URL` — Postgres connection string

Without it the app falls back to the local file store. On a serverless host
(Vercel, Netlify) the filesystem is ephemeral and per-instance, so writes
appear to succeed and then disappear.

Any Postgres works — Neon, Supabase, Railway, RDS. On Neon, use the **pooled**
connection string:

```
postgresql://user:password@host/dbname?sslmode=require
```

No migration step is needed. The schema is created on first connection, and
each collection seeds itself with demo data on first read.

### 2. `AUTH_SECRET` — session signing key

At least 16 characters. Without it the app signs session cookies with a fixed
string that lives in `src/server/auth.ts` — meaning anyone who can read the
source can forge a cookie for any account and sign in with no password.

```bash
openssl rand -base64 32
```

### 3. `ANTHROPIC_API_KEY` *(optional)*

Unlocks the full conversational agent on the Chat screen. Without it the
assistant still answers real questions about your CRM data; with it, it runs a
Claude agent over that same data.

### Deploy

Push to a Git repo, import it in Vercel, add the variables above under
**Settings → Environment Variables**, and deploy. Then confirm:

```bash
curl https://your-app.vercel.app/api/health
```

```json
{ "status": "ok", "checks": { "sessionSigningKey": "ok", "storage": "ok: postgres" } }
```

`/api/health` returns **503** and names whichever variable is missing until
both are set. It reports booleans only, never the values, so it is safe to
leave unauthenticated. The same status appears in-app under **Settings → Data
storage**.

**Change the demo account's password** after your first sign-in.

---

## Architecture

```
src/data/*         seed data + shared types (enum arrays are the source of truth)
src/server/*       repositories, auth, storage, agents — server-only
src/app/(app)/*    the application, one folder per screen
src/app/(auth)/*   sign in / sign up
```

**Storage seam.** Every repository reads and writes through
`src/server/store.ts`, which routes on `DATABASE_URL` — Postgres or local
files. No repository knows which engine is underneath.

**Writes are atomic.** Use `mutateTable(name, seed, mutate)` for anything that
reads-then-writes; it takes a Postgres advisory lock (or an in-process mutex on
the file store). Pairing `readTable` with `writeTable` for a dependent write
loses data under concurrency. Any validation that guards a write must run
*inside* the mutator, or it's a check-then-act race.

**Server actions are public endpoints.** TypeScript is erased at runtime, so
every action validates its input through `src/server/validate.ts` before it
reaches a repository. `as SomeType` is not validation.

**Store the fact, derive the label.** Anything relative to now — "Today",
"2 days ago" — is computed at read time from a stored absolute value, never
frozen at write time.

## Scripts

```bash
npm run dev       # dev server
npm run build     # production build
npm start         # serve the production build
npm run lint      # eslint
npx tsc --noEmit  # typecheck
```
