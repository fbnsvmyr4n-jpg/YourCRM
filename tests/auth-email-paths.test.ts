import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { startTestDb, type TestDb, AGENCY, TENANT_A, USER_A } from "./helpers/pg";
import type { TenantContext } from "../src/server/tenant";

/**
 * The two emails that matter when nobody is watching.
 *
 * A quotation has somebody waiting for it. These do not: a password reset goes
 * to a person who cannot get in and has no one to ask, and an invitation goes
 * to somebody who does not yet know they were invited. When either fails there
 * is no client to complain, which is exactly why they were the two left doing
 * it inline.
 *
 * The most important test here is not about email at all. It is that a failed
 * reset send must ANSWER THE SAME WAY as a successful one — because a send is
 * only ever attempted for an address that exists, so two different answers
 * turn the form into a way of discovering which addresses are registered.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let outbox: typeof import("../src/server/outbox");
let handlers: typeof import("../src/server/outbox-handlers");
let repo: typeof import("../src/server/repos/outbox");
let closePool: typeof import("../src/server/db").closePool;

const CTX: TenantContext = {
  agencyId: AGENCY,
  subAccountId: TENANT_A,
  userId: USER_A,
  role: "owner",
};
const inA = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(CTX, fn);

type Sent = { to: string[]; idempotencyKey: string | null; text: string };
let sends: Sent[] = [];
let reply: { status: number; body?: string } = { status: 200 };

function stubMail() {
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (!href.includes("api.resend.com")) throw new Error(`unexpected fetch to ${href}`);
    const body = JSON.parse(String(init?.body ?? "{}"));
    sends.push({
      to: body.to,
      text: String(body.text ?? ""),
      idempotencyKey: new Headers(init?.headers).get("Idempotency-Key"),
    });
    return new Response(reply.body ?? "{}", { status: reply.status });
  });
}

beforeAll(async () => {
  db = await startTestDb();
  process.env.RESEND_API_KEY = "re_test_not_a_real_key";
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  outbox = await import("../src/server/outbox");
  handlers = await import("../src/server/outbox-handlers");
  repo = await import("../src/server/repos/outbox");
});

afterAll(async () => {
  delete process.env.RESEND_API_KEY;
  await closePool?.();
  await db.stop();
});

afterEach(() => vi.unstubAllGlobals());

beforeEach(async () => {
  sends = [];
  reply = { status: 200 };
  stubMail();
  await db.seed(`
    DELETE FROM outbox; DELETE FROM password_resets;
    DELETE FROM users WHERE id = 'u_invited';`);
});

/** Somebody who has been added to the team but has not been let in yet. */
async function invitedUser() {
  await db.seed(`
    INSERT INTO users (id, agency_id, sub_account_id, email, password_hash, name, role)
    VALUES ('u_invited', '${AGENCY}', '${TENANT_A}', 'newcolleague@test.local', 'x', 'New Colleague', 'member');`);
  return "u_invited";
}

const queueInvite = (userId: string) =>
  inA((q) =>
    outbox.queueJob(q, handlers.OUTBOX_REGISTRY, {
      handler: handlers.INVITE_EMAIL,
      payload: { userId, origin: "https://crm.test" },
      dedupeKey: handlers.inviteEmailKey(userId),
    })
  );

describe("inviting a colleague", () => {
  it("sends them a link that sets their password", async () => {
    const id = await invitedUser();
    await queueInvite(id);

    expect(await outbox.drain(CTX, handlers.OUTBOX_REGISTRY)).toMatchObject({ ran: 1, done: 1 });
    expect(sends).toHaveLength(1);
    expect(sends[0].to).toEqual(["newcolleague@test.local"]);
    expect(sends[0].text, "the invitation carries no way in").toMatch(
      /https:\/\/crm\.test\/reset-password\?token=/
    );
  });

  it("uses the host the invitation was made from, not a guess", async () => {
    /* A background drain has no request to read a host from, and a workspace
       on a custom domain would otherwise get links pointing somewhere else. */
    const id = await invitedUser();
    await inA((q) =>
      outbox.queueJob(q, handlers.OUTBOX_REGISTRY, {
        handler: handlers.INVITE_EMAIL,
        payload: { userId: id, origin: "https://crm.acme.co.za" },
        dedupeKey: handlers.inviteEmailKey(id),
      })
    );
    await outbox.drain(CTX, handlers.OUTBOX_REGISTRY);
    expect(sends[0].text).toMatch(/https:\/\/crm\.acme\.co\.za\/reset-password/);
  });

  it("mints a token that actually works", async () => {
    /* The link is the entire value of the email. A token that does not resolve
       is the same as not sending it. */
    const id = await invitedUser();
    await queueInvite(id);
    await outbox.drain(CTX, handlers.OUTBOX_REGISTRY);

    const token = decodeURIComponent(sends[0].text.match(/token=([^\s&]+)/)![1]);
    const { withSystem } = await import("../src/server/tenant");
    const { peekResetToken } = await import("../src/server/repos/auth");
    const claim = await withSystem((q) => peekResetToken(q, token));
    expect(claim?.userId).toBe(id);
  });

  it("KEEPS TRYING when the provider is down, instead of stranding them", async () => {
    /*
       The failure this move exists for. The colleague is created either way —
       they are on the team with no way in — and the old inline send left one
       error message that vanished on the next page load.
    */
    reply = { status: 500, body: "provider down" };
    const id = await invitedUser();
    await queueInvite(id);

    expect(await outbox.drain(CTX, handlers.OUTBOX_REGISTRY)).toMatchObject({ retried: 1 });
    expect(await inA((q) => repo.pendingCount(q))).toBe(1);
  });

  it("waits, rather than dying, when the workspace has no mail provider", async () => {
    /* Production's current state. These should go out when a key is set, not
       be dead by the time it is. */
    delete process.env.RESEND_API_KEY;
    try {
      const id = await invitedUser();
      await queueInvite(id);
      expect(await outbox.drain(CTX, handlers.OUTBOX_REGISTRY)).toMatchObject({ retried: 1 });
      expect(sends).toHaveLength(0);
    } finally {
      process.env.RESEND_API_KEY = "re_test_not_a_real_key";
    }
  });

  it("gives up on an address the provider refuses, and says so where it shows", async () => {
    reply = { status: 422, body: "invalid `to` field" };
    const id = await invitedUser();
    await queueInvite(id);

    expect(await outbox.drain(CTX, handlers.OUTBOX_REGISTRY)).toMatchObject({ dead: 1 });
    const dead = await inA((q) => repo.deadJobs(q));
    expect(dead[0].handler).toBe(handlers.INVITE_EMAIL);
    expect(dead[0].lastError).toMatch(/422/);
  });

  it("settles quietly when the person was removed from the team since", async () => {
    const id = await invitedUser();
    await queueInvite(id);
    await db.seed(`UPDATE users SET deleted_at = now() WHERE id = '${id}'`);

    expect(await outbox.drain(CTX, handlers.OUTBOX_REGISTRY)).toMatchObject({ done: 1 });
    expect(sends).toHaveLength(0);
  });

  it("queues one job however many times invite is pressed", async () => {
    const id = await invitedUser();
    await queueInvite(id);
    await queueInvite(id);
    expect(await inA((q) => repo.pendingCount(q))).toBe(1);

    await outbox.drain(CTX, handlers.OUTBOX_REGISTRY);
    expect(sends).toHaveLength(1);
  });

  it("carries the job id to the provider, so a retry is not a second invitation", async () => {
    const id = await invitedUser();
    const jobId = await queueInvite(id);
    await outbox.drain(CTX, handlers.OUTBOX_REGISTRY);
    expect(sends[0].idempotencyKey).toBe(jobId);
  });
});

describe("what the inviter is told", () => {
  /**
   * Read from the source: the action resolves a session and request headers
   * that do not exist here. What is pinned is that the three outcomes are
   * actually distinguished — driving the real form is what found them
   * collapsed into one.
   */
  const teamSource = () =>
    readFileSync("src/app/(app)/settings/team-actions.ts", "utf8");

  it("does not describe a job that has STOPPED as one still being tried", () => {
    /*
       The defect driving it found. Every outcome said "we will keep trying",
       including the one where the provider had already refused permanently and
       the job was dead before the page re-rendered. The inviter was told to
       wait for something that was never going to happen — the same mistake, in
       the same words, that had already been fixed for quotations.
    */
    const code = teamSource().replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code, "a dead invitation job is no longer distinguished").toMatch(
      /job\?\.status === "dead"/
    );
    expect(code, "the provider's reason is not passed on to the inviter").toMatch(
      /job\.lastError/
    );
  });

  it("still tells them plainly when it did go", () => {
    expect(teamSource()).toMatch(/job\?\.status === "done"/);
  });
});

describe("what a password reset reveals about who has an account", () => {
  /**
   * Read from the source rather than driven, because the action resolves a
   * session and request headers that do not exist here. What is being pinned
   * is a property of the CODE: that no branch after the account lookup can
   * return something different from the generic answer.
   */
  const source = () => readFileSync("src/app/(auth)/reset-actions.ts", "utf8");

  it("has no branch that answers differently when the send fails", async () => {
    /*
       The defect this replaced, stated plainly: a send is only ever attempted
       for an address that HAS an account, because the function returns the
       generic line early when it does not. So returning an error on a failed
       send meant error = registered, generic = not registered — and with no
       mail provider configured, EVERY registered address took the error
       branch. That was production's state.
    */
    const code = source()
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    /* Bounded to requestResetAction ALONE. The first version of this ran to
       the end of the file and caught `resetPasswordAction`, where "this link
       has expired" is a correct and necessary error — a guard that fires on
       the right property in the wrong place is still a broken guard. */
    const start = code.indexOf("const user = await withSystem");
    const nextFn = code.indexOf("export async function", start);
    expect(start, "the account lookup moved — this guard no longer reads the right code").toBeGreaterThan(0);
    expect(nextFn, "requestResetAction is no longer followed by another export").toBeGreaterThan(start);
    const after = code.slice(start, nextFn);
    const errorReturns = [...after.matchAll(/return\s*\{[^}]*\berror\b/g)];
    expect(
      errorReturns,
      "a branch after the account lookup returns an error — that distinguishes a registered address"
    ).toHaveLength(0);
  });

  it("still records the failure for whoever runs the service", () => {
    /* Silence for the stranger, not for the operator. Without this the fix
       would trade one problem for another: nobody would ever learn that reset
       emails had stopped working. */
    const code = source();
    expect(code, "a failed reset send is no longer recorded anywhere").toMatch(/logAuth\(/);
    expect(code, "the reset failure is not distinguishable in the log").toMatch(/reset\.failed/);
  });

  it("logs the user id rather than the address", () => {
    /* The log identifies the account for somebody with database access and
       discloses nothing to anybody else. */
    const after = source().slice(source().indexOf("if (!result.sent)"));
    expect(after).toMatch(/userId: user\.id/);
    expect(after, "the address was put in the log").not.toMatch(/email: user\.email/);
  });
});
