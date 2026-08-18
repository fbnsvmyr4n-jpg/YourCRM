import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, TENANT_A, TENANT_B, AGENCY, USER_A } from "./helpers/pg";
import type { TenantContext } from "../src/server/tenant";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Users, reset tokens, rate limiting, settings and chat.
 *
 * The first three run through `withSystem` rather than `withTenant`, because
 * they happen before anybody is signed in — rate limiting a login has to work
 * for an account nobody has identified yet. The last two are ordinary
 * tenant-scoped repositories.
 *
 * Most of what is worth testing here is security behaviour: that a token is
 * genuinely single-use, that a counter cannot be raced, that a password hash
 * never leaves its module, and that two people cannot claim the same email.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let withSystem: typeof import("../src/server/tenant").withSystem;
let users: typeof import("../src/server/repos/users");
let auth: typeof import("../src/server/repos/auth");
let settings: typeof import("../src/server/repos/settings");
let chat: typeof import("../src/server/repos/chat");
let closePool: typeof import("../src/server/db").closePool;

const ctxFor = (subAccountId: string, userId = USER_A): TenantContext => ({
  agencyId: AGENCY,
  subAccountId,
  userId,
  role: "owner",
});

beforeAll(async () => {
  db = await startTestDb();
  process.env.AUTH_SECRET ??= "test-secret-for-hashing-only-not-a-real-one";
  ({ withTenant, withSystem } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  users = await import("../src/server/repos/users");
  auth = await import("../src/server/repos/auth");
  settings = await import("../src/server/repos/settings");
  chat = await import("../src/server/repos/chat");
});

afterAll(async () => {
  await closePool();
  await db.stop();
});

const inA = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctxFor(TENANT_A), fn);
const inB = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctxFor(TENANT_B), fn);

let seq = 0;
const newEmail = () => `user${++seq}.${Date.now()}@test.local`;

const register = (over: Partial<Parameters<typeof users.createUser>[1]> = {}) =>
  withSystem((q) =>
    users.createUser(q, {
      agencyId: AGENCY,
      email: newEmail(),
      password: "correct horse battery",
      name: "Test Person",
      ...over,
    })
  );

// ---------------------------------------------------------------------------

describe("users", () => {
  it("creates an account and never exposes the password hash", async () => {
    const { user } = await register({ name: "  Ada Lovelace  " });
    expect(user?.name, "input was not trimmed").toBe("Ada Lovelace");
    // The shape that carries the hash is not exported, so there is no
    // "remember to strip it" step that somebody can forget.
    expect(Object.keys(user!)).not.toContain("passwordHash");
    expect(JSON.stringify(user)).not.toMatch(/password/i);
  });

  it("refuses a second account on the same email, whatever the case", async () => {
    /**
     * Sign-in identifies an account by email with no tenant alongside it, so
     * two live users sharing an address makes authentication ambiguous — and
     * the resolution would be "whichever row came back first", which can sign
     * somebody into the wrong agency.
     */
    const email = newEmail();
    expect((await register({ email })).user).toBeTruthy();

    const dup = await register({ email });
    expect(dup.error, "a duplicate email was accepted").toMatch(/already exists/i);

    const shouty = await register({ email: email.toUpperCase() });
    expect(shouty.error, "the same address in capitals was accepted").toMatch(/already exists/i);
  });

  it("frees the email again once the account is deleted", async () => {
    const email = newEmail();
    const { user } = await register({ email });
    expect(await withSystem((q) => users.deleteUser(q, user!.id))).toBe(true);
    expect((await register({ email })).user, "a departed user's address stayed taken").toBeTruthy();
  });

  it("validates before it writes", async () => {
    expect((await register({ email: "not-an-email" })).error).toMatch(/email address/i);
    expect((await register({ password: "short" })).error).toMatch(/8 characters/i);
    expect((await register({ name: "   " })).error).toMatch(/name/i);
  });

  it("authenticates with the right password and refuses the wrong one", async () => {
    const email = newEmail();
    await register({ email, password: "correct horse battery" });

    expect(await withSystem((q) => users.authenticate(q, email, "correct horse battery"))).toBeTruthy();
    expect(await withSystem((q) => users.authenticate(q, email, "wrong"))).toBeNull();
  });

  it("answers identically for a wrong password and an unknown account", async () => {
    // Distinguishable answers leak which addresses have accounts, and that
    // difference usually reaches the user as two different error messages.
    const { user } = await register({});
    const wrongPassword = await withSystem((q) => users.authenticate(q, user!.email, "nope"));
    const noSuchUser = await withSystem((q) =>
      users.authenticate(q, "nobody@test.local", "nope")
    );
    expect(wrongPassword).toBe(noSuchUser);
  });

  it("signs in whatever case the address is typed in", async () => {
    /**
     * The address is stored lowercased, so a lookup comparing the raw input
     * would refuse the person who typed it exactly as they registered it —
     * they would simply be unable to sign in, with a "wrong password" message.
     * A mutation making this comparison case-sensitive passed the whole suite
     * before this test existed, because only `findUserByEmail` was covered.
     */
    const email = `MiXeD.${Date.now()}@Test.Local`;
    await register({ email, password: "correct horse battery" });

    for (const typed of [email, email.toLowerCase(), email.toUpperCase()]) {
      expect(
        await withSystem((q) => users.authenticate(q, typed, "correct horse battery")),
        `could not sign in with the address typed as "${typed}"`
      ).toBeTruthy();
    }
  });

  it("finds a user by email case-insensitively", async () => {
    const email = newEmail();
    await register({ email });
    expect(await withSystem((q) => users.findUserByEmail(q, email.toUpperCase()))).toBeTruthy();
  });

  it("hides a deleted user from lookups", async () => {
    const { user } = await register({});
    await withSystem((q) => users.deleteUser(q, user!.id));
    expect(await withSystem((q) => users.findUserById(q, user!.id))).toBeNull();
    expect(await withSystem((q) => users.authenticate(q, user!.email, "correct horse battery"))).toBeNull();
  });

  it("requires the current password to change it", async () => {
    // Otherwise a borrowed session locks the real owner out permanently.
    const { user } = await register({ password: "original password" });
    const wrong = await withSystem((q) =>
      users.changePassword(q, user!.id, "guessed", "brand new password")
    );
    expect(wrong.error).toMatch(/current password/i);

    const right = await withSystem((q) =>
      users.changePassword(q, user!.id, "original password", "brand new password")
    );
    expect(right.ok).toBe(true);
    expect(await withSystem((q) => users.authenticate(q, user!.email, "brand new password"))).toBeTruthy();
  });

  it("lists only one agency's people", async () => {
    await db.seed(`INSERT INTO agencies (id, name) VALUES ('ag_other', 'Other') ON CONFLICT DO NOTHING`);
    const mine = await register({});
    const theirs = await register({ agencyId: "ag_other" });

    const list = await withSystem((q) => users.listUsers(q, AGENCY));
    expect(list.map((u) => u.id)).toContain(mine.user!.id);
    expect(list.map((u) => u.id), "another agency's user was listed").not.toContain(theirs.user!.id);
  });
});

// ---------------------------------------------------------------------------

describe("password reset tokens", () => {
  it("stores only a hash, never the token", async () => {
    const { user } = await register({});
    const raw = await withSystem((q) => auth.createResetToken(q, user!.id, user!.email));

    const rows = await withSystem((q) =>
      q.rows<{ token_hash: string }>(`SELECT token_hash FROM password_resets WHERE user_id = $1`, [
        user!.id,
      ])
    );
    expect(rows).toHaveLength(1);
    // A live reset token IS a credential: if this table leaks, the rows must be
    // useless to whoever reads them.
    expect(rows[0].token_hash, "the raw token was stored").not.toBe(raw);
    expect(rows[0].token_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is single-use — a second submission of the same link gets nothing", async () => {
    /**
     * Verified and deleted in one statement. Select-then-delete would let two
     * submissions both pass the check before either removed the row, which is
     * precisely how a "single-use" token gets used twice.
     */
    const { user } = await register({});
    const raw = await withSystem((q) => auth.createResetToken(q, user!.id, user!.email));

    expect(await withSystem((q) => auth.consumeResetToken(q, raw))).toEqual({ userId: user!.id });
    expect(await withSystem((q) => auth.consumeResetToken(q, raw)), "the token worked twice").toBeNull();
  });

  it("invalidates the previous link when a new one is requested", async () => {
    // Otherwise every request leaves another working key to the account lying
    // around for an hour.
    const { user } = await register({});
    const first = await withSystem((q) => auth.createResetToken(q, user!.id, user!.email));
    await withSystem((q) => auth.createResetToken(q, user!.id, user!.email));
    expect(await withSystem((q) => auth.consumeResetToken(q, first))).toBeNull();
  });

  it("refuses an expired token and purges it", async () => {
    const { user } = await register({});
    const raw = await withSystem((q) => auth.createResetToken(q, user!.id, user!.email));
    await db.seed(`UPDATE password_resets SET expires_at = now() - interval '1 minute'`);

    expect(await withSystem((q) => auth.peekResetToken(q, raw))).toBeNull();
    expect(await withSystem((q) => auth.consumeResetToken(q, raw))).toBeNull();
    expect(await withSystem((q) => auth.purgeExpiredResets(q))).toBeGreaterThan(0);
  });

  it("refuses a token that was never issued", async () => {
    expect(await withSystem((q) => auth.consumeResetToken(q, "made-up-token"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("login rate limiting", () => {
  const key = () => auth.emailKey(`victim${++seq}@test.local`);

  it("allows attempts until the limit, then locks out", async () => {
    const k = key();
    for (let i = 0; i < 4; i++) await withSystem((q) => auth.registerFailedLogin(q, [k]));
    expect(await withSystem((q) => auth.checkLoginRate(q, [k]))).toEqual({ allowed: true });

    await withSystem((q) => auth.registerFailedLogin(q, [k]));
    const verdict = await withSystem((q) => auth.checkLoginRate(q, [k]));
    expect(verdict.allowed, "a fifth failure did not lock the account").toBe(false);
    if (!verdict.allowed) expect(verdict.retryAfterSec).toBeGreaterThan(0);
  });

  it("counts in the database, not by reading and writing back", async () => {
    // Concurrent guesses are the situation this defends against, and a
    // read-modify-write counter loses increments exactly when it is under
    // attack — the only time it matters.
    const src = readFileSync(join(__dirname, "..", "src", "server", "repos", "auth.ts"), "utf8");
    expect(src).toMatch(/ON CONFLICT \(key\) DO UPDATE SET/);
    expect(src).toMatch(/login_attempts\.failures \+ 1/);
  });

  it("keeps the email and IP namespaces apart", async () => {
    // Without the prefix, an address shaped like an IP could consume the other
    // namespace's budget.
    expect(auth.emailKey("a@b.com")).toMatch(/^email:/);
    expect(auth.ipKey("1.2.3.4")).toMatch(/^ip:/);
    expect(auth.signupKey("1.2.3.4")).toMatch(/^signup:/);
    expect(auth.emailKey("A@B.com"), "the same address counted twice by case").toBe(
      auth.emailKey("a@b.com")
    );
  });

  it("gives an IP a larger budget than a single email", async () => {
    // Per-email stops guessing at one known account; per-IP stops spraying one
    // password across many accounts, which per-email alone never notices.
    const ip = auth.ipKey(`10.0.0.${++seq}`);
    for (let i = 0; i < 6; i++) await withSystem((q) => auth.registerFailedLogin(q, [ip]));
    expect(await withSystem((q) => auth.checkLoginRate(q, [ip])), "an IP locked at the email limit").toEqual({
      allowed: true,
    });
  });

  it("starts a fresh window once the old one has passed", async () => {
    // An honest user who mistyped a password twice last week should not be one
    // attempt from a lockout.
    const k = key();
    for (let i = 0; i < 4; i++) await withSystem((q) => auth.registerFailedLogin(q, [k]));
    await db.seed(`UPDATE login_attempts SET first_at = now() - interval '20 minutes'`);

    await withSystem((q) => auth.registerFailedLogin(q, [k]));
    const state = await withSystem((q) => auth.loginAttemptState(q, k));
    expect(state?.failures, "the counter carried over from an expired window").toBe(1);
    expect(await withSystem((q) => auth.checkLoginRate(q, [k]))).toEqual({ allowed: true });
  });

  it("clears on a successful sign-in", async () => {
    const k = key();
    for (let i = 0; i < 5; i++) await withSystem((q) => auth.registerFailedLogin(q, [k]));
    await withSystem((q) => auth.clearLoginRate(q, [k]));
    expect(await withSystem((q) => auth.checkLoginRate(q, [k]))).toEqual({ allowed: true });
  });
});

// ---------------------------------------------------------------------------

describe("settings are per sub-account, never global", () => {
  it("returns defaults for a sub-account that has saved nothing", async () => {
    const s = await inB((q) => settings.getSettings(q));
    expect(s.weeklyCapacity).toBe(20);
    // Zero, not an invented goal: a default of 50,000 would render as a real
    // target and make every progress bar a fiction.
    expect(s.monthlyTargetCents).toBe(0);
  });

  it("does not share a target between sub-accounts", async () => {
    /**
     * The defect this replaces: settings were a global singleton keyed
     * "workspace", so every customer on the platform would have shared one
     * monthly target and one meeting capacity.
     */
    await inA((q) => settings.updateSettings(q, { monthlyTargetCents: 5_000_000 }));
    expect((await inA((q) => settings.getSettings(q))).monthlyTargetCents).toBe(5_000_000);
    expect(
      (await inB((q) => settings.getSettings(q))).monthlyTargetCents,
      "another sub-account inherited this target"
    ).toBe(0);
  });

  it("upserts, so the first save needs no separate create step", async () => {
    const saved = await inB((q) => settings.updateSettings(q, { weeklyCapacity: 35 }));
    expect(saved.weeklyCapacity).toBe(35);
    expect((await inB((q) => settings.getSettings(q))).weeklyCapacity).toBe(35);
  });

  it("keeps the field it was not given", async () => {
    await inA((q) => settings.updateSettings(q, { monthlyTargetCents: 900_000, weeklyCapacity: 12 }));
    const after = await inA((q) => settings.updateSettings(q, { weeklyCapacity: 15 }));
    expect(after.monthlyTargetCents, "an unmentioned field was reset").toBe(900_000);
  });

  it("rejects impossible values", async () => {
    await expect(inA((q) => settings.updateSettings(q, { monthlyTargetCents: 1.5 }))).rejects.toThrow(
      /whole cents/i
    );
    await expect(inA((q) => settings.updateSettings(q, { monthlyTargetCents: -1 }))).rejects.toThrow(
      /negative/i
    );
    // Zero capacity divides by zero in every "x of y meetings" figure.
    await expect(inA((q) => settings.updateSettings(q, { weeklyCapacity: 0 }))).rejects.toThrow(
      /at least 1/i
    );
  });
});

// ---------------------------------------------------------------------------

describe("chat is private to one person", () => {
  it("keeps a transcript in order, oldest first", async () => {
    await db.seed(`DELETE FROM chat_messages`);
    await inA((q) => chat.appendChat(q, "user", "What should I do today?"));
    await inA((q) => chat.appendChat(q, "assistant", "Follow up on three deals."));

    const rows = await inA((q) => chat.listChat(q));
    expect(rows.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(rows[0].text).toBe("What should I do today?");
  });

  it("truncates from the start, keeping what was just said", async () => {
    // A limit that took the OLDEST rows would cut off the live end of the
    // conversation, which is the part anybody is reading.
    await db.seed(`DELETE FROM chat_messages`);
    for (let i = 1; i <= 5; i++) await inA((q) => chat.appendChat(q, "user", `message ${i}`));
    const rows = await inA((q) => chat.listChat(q, 2));
    expect(rows.map((m) => m.text)).toEqual(["message 4", "message 5"]);
  });

  it("does not show one colleague another's conversation", async () => {
    /**
     * They share every contact and deal in the sub-account, which is exactly
     * why this needs stating: a chat thread is a person talking to an
     * assistant, and treating it as shared workspace data would be a
     * surprising way to leak what somebody asked.
     */
    await db.seed(`DELETE FROM chat_messages`);
    await db.seed(
      `INSERT INTO users (id, agency_id, sub_account_id, email, password_hash, name, role)
       VALUES ('u_colleague', '${AGENCY}', '${TENANT_A}', 'colleague@test.local', 'x', 'Colleague', 'member')
       ON CONFLICT DO NOTHING`
    );
    await inA((q) => chat.appendChat(q, "user", "My private question"));

    const theirs = await withTenant(ctxFor(TENANT_A, "u_colleague"), (q) => chat.listChat(q));
    expect(theirs, "a colleague could read this conversation").toEqual([]);
  });

  it("clears only the caller's own history", async () => {
    await db.seed(`DELETE FROM chat_messages`);
    await inA((q) => chat.appendChat(q, "user", "Mine"));
    await withTenant(ctxFor(TENANT_A, "u_colleague"), (q) => chat.appendChat(q, "user", "Theirs"));

    expect(await inA((q) => chat.clearChat(q))).toBe(1);
    expect(await inA((q) => chat.listChat(q))).toEqual([]);
    const theirs = await withTenant(ctxFor(TENANT_A, "u_colleague"), (q) => chat.listChat(q));
    expect(theirs.map((m) => m.text), "clearing wiped a colleague's history too").toEqual(["Theirs"]);
  });

  it("refuses a blank message or an unknown role", async () => {
    await expect(inA((q) => chat.appendChat(q, "user", "   "))).rejects.toThrow(/text/i);
    await expect(inA((q) => chat.appendChat(q, "system" as never, "hi"))).rejects.toThrow(/role/i);
  });

  it("hides another tenant's chat", async () => {
    await db.seed(`DELETE FROM chat_messages`);
    await inA((q) => chat.appendChat(q, "user", "Tenant A only"));
    expect(await inB((q) => chat.listChat(q))).toEqual([]);
  });
});
