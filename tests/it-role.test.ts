/*
   What an IT admin can actually reach.

   The finance pass found a capability that existed and was unreachable — the
   role that settles invoices could not open one. This is the same failure in a
   different place, found the same way: by signing in as the role and using it.

   Driven as `admin`, the whole product was two sidebar rows (Settings, Support)
   and a notification badge reading "2". The badge was CORRECT — `canAccessOps`
   exists precisely so IT hears that a quotation could not be emailed — and
   every entry in it linked to a page their own tier redirects them away from:

     1 quotation could not be emailed   → /chat
     1 call could not be read           → /voice-agents
     1 invoice could not be sent        → /projects
     1 purchase order could not be sent → /purchase-orders
     1 message could not be sent        → /inbox
     1 booking confirmation …           → /meetings
     N automations could not run        → /settings?s=automations  (needsCrm)

   Seven destinations, seven walls. The feed's own premise, written at the top
   of `notifications.ts`, is that an entry is "a way *into* the work, not just a
   report that work exists" — and for the one role whose job is "something is
   broken" it was a report every time, over a count that could never be cleared.

   `canAccessOps` had exactly ONE reader in the entire codebase: the line
   deciding whether to fill that bell.
*/
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canAccessCrm, canAccessMail, canAccessMoney, canAccessOps } from "@/server/permissions";
import { JOB_LABELS, jobLabel } from "@/data/jobs";
import { visibleNav } from "@/components/shell/nav";

const read = (p: string) => readFileSync(`${process.cwd()}/${p}`, "utf8");

describe("the operations tier", () => {
  it("belongs to IT and the owner, and to nobody else", () => {
    expect(canAccessOps("admin")).toBe(true);
    expect(canAccessOps("owner")).toBe(true);
    /* Accounts are not on call for a stuck queue, and a salesperson has no
       business retrying somebody else's delivery. */
    expect(canAccessOps("finance")).toBe(false);
    expect(canAccessOps("member")).toBe(false);
    expect(canAccessOps("viewer")).toBe(false);
    expect(canAccessOps("nonsense"), "an unknown role is not fail-closed").toBe(false);
  });

  it("is a DOOR, not a rank — IT still sees no customers, no money, no mail", () => {
    /* The whole point of four tables rather than one ladder. An admin
       administers everybody and reads nobody's phone number. */
    expect(canAccessCrm("admin")).toBe(false);
    expect(canAccessMoney("admin")).toBe(false);
    expect(canAccessMail("admin")).toBe(false);
  });

  it("is asked at the same one place as the others", () => {
    const session = read("src/server/tenant-session.ts");
    expect(session).toMatch(/key: "ops", name: "operations", may: canAccessOps/);
  });
});

describe("the screen it opens", () => {
  it("exists, which it did not", () => {
    expect(() => read("src/app/(app)/system/page.tsx")).not.toThrow();
    expect(read("src/app/(app)/system/page.tsx")).toMatch(/ops: true/);
  });

  it("is in the navigation, and ONLY for a reader who holds the tier", () => {
    const forIt = visibleNav({ crm: false, money: false, mail: false, ops: true })
      .flatMap((s) => s.items)
      .map((i) => i.href);
    expect(forIt).toContain("/system");

    /*
       And a salesperson is not offered it. This is the half that would have
       been missed: `visibleNav` began `if (crmAccess) return NAV`, so the
       moment a row existed that CRM access does not grant, every CRM reader was
       handed a link to a page their own gate turns them away from — the same
       dead end, pointed the other way.
    */
    for (const role of [
      { crm: true, money: true, mail: true, ops: false },
      { crm: false, money: true, mail: true, ops: false },
    ]) {
      const hrefs = visibleNav(role).flatMap((s) => s.items).map((i) => i.href);
      expect(hrefs, `${JSON.stringify(role)} was offered the operations screen`).not.toContain(
        "/system"
      );
    }
  });

  it("CARRIES NO RECORD CONTENT, which is what lets the tier exist", () => {
    /*
       An admin may learn that a send failed and why. They may not learn who it
       was to or what it said — and the moment this screen shows a recipient to
       make a row more useful, the separation between IT and the CRM stops
       meaning anything.

       So the payload is not selected. It holds record ids; the handler name
       says what KIND of thing it was, which is what somebody fixing a mail
       domain actually needs.
    */
    const repo = read("src/server/repos/outbox.ts");
    const fn = repo.slice(repo.indexOf("export async function stuckWork"));
    const select = fn.slice(0, fn.indexOf("[q.ctx.subAccountId"));
    expect(select, "stuckWork selects the payload").not.toMatch(/payload/);

    const view = read("src/app/(app)/system/SystemHealthView.tsx");
    expect(view, "the screen no longer says what it does not show").toMatch(
      /It\s*\n?\s*never shows who a message was for or what it said\./
    );
  });
});

describe("the bell finally goes somewhere", () => {
  it("points IT at the screen, not at the pages their tier refuses", () => {
    const notifications = read("src/server/notifications.ts");
    const opsFeed = notifications.slice(
      notifications.indexOf("export async function listOpsNotifications")
    );
    expect(opsFeed.slice(0, 1600)).toMatch(/\.map\(\(entry\) => \(\{ \.\.\.entry, href: "\/system" \}\)\)/);
  });

  it("still sends the person whose work it was to the work itself", () => {
    /*
       The rewrite is for the OPS feed alone. A quotation that could not be
       emailed should still take a salesperson to the quote — they hold that
       tier, and System health would be the wrong place for them to land.
    */
    const notifications = read("src/server/notifications.ts");
    expect(notifications).toMatch(/href: "\/chat"/);
    expect(notifications).toMatch(/href: "\/purchase-orders"/);
  });
});

describe("what IT can press", () => {
  it("can retry, and the attempts start again from zero", () => {
    /* The counter is reset on purpose: the attempts that were spent were spent
       against a broken thing, and somebody is pressing this BECAUSE they have
       just fixed it. Carrying the old count forward would let the backoff give
       up again almost immediately on a system that now works. */
    const repo = read("src/server/repos/outbox.ts");
    const retry = repo.slice(repo.indexOf("export async function retryJob"));
    expect(retry.slice(0, 700)).toMatch(/status = 'pending', attempts = 0, run_after = now\(\)/);
  });

  it("CANNOT retry a job that is already running", () => {
    /*
       `AND status = 'dead'` is not belt-and-braces. Without it a double press
       would revive a job the worker had already claimed and hand back the lease
       that stops two workers running the same job — which is how a client gets
       the same quotation twice.
    */
    const repo = read("src/server/repos/outbox.ts");
    const retry = repo.slice(repo.indexOf("export async function retryJob"));
    expect(retry.slice(0, 700)).toMatch(/AND id = \$2 AND status = 'dead'/);
  });

  it("can stop trying one, WITHOUT the record being destroyed", () => {
    /*
       A count nobody can clear is a count everybody learns to ignore, and then
       the next real failure is invisible too. So the bell can go quiet — and
       the only thing that changes is a stamp saying a named person looked at
       it. The status stays `dead`, the error stays readable, the attempts stay
       counted.
    */
    const repo = read("src/server/repos/outbox.ts");
    const discard = repo.slice(repo.indexOf("export async function discardJob"));
    const sql = discard.slice(0, 600);
    /* The SET clause is the whole assertion: a stamp, and nothing else. It
       still READS the status in its WHERE — `AND status = 'dead' AND
       discarded_at IS NULL` is what stops a second press stamping a row twice
       or judging one that is running. */
    const setClause = sql.slice(sql.indexOf("SET "), sql.indexOf("WHERE"));
    expect(setClause).toMatch(/discarded_at = now\(\), discarded_by_user_id = \$3/);
    expect(setClause, "a discard rewrites the status, losing why it failed").not.toMatch(
      /status =/
    );
    expect(setClause, "a discard clears the error it exists to preserve").not.toMatch(
      /last_error/
    );
  });

  it("does not have a FOURTH STATUS invented for it", () => {
    /*
       The obvious move and the wrong one. `dead` is a fact about the job — it
       was attempted and given up on — and "a person has seen this and is not
       retrying it" is a fact about a PERSON. Folded into one column, the day
       you want to know which failures were judged and which were merely
       ignored, the answer has been overwritten.
    */
    const schema = read("src/server/schema.sql");
    expect(schema).toMatch(/CHECK \(status IN \('pending', 'done', 'dead'\)\)/);
  });

  it("is a separate question from writing customer records", () => {
    /* `canWrite` means "may change CUSTOMER records" and is correctly false for
       IT. Used as "may this person do anything", it would hide both controls on
       the one screen the role exists for — the mistake that denied a bookkeeper
       a reply button, in a new place. */
    const view = read("src/app/(app)/system/SystemHealthView.tsx");
    expect(view).toMatch(/const canAct = useCanRunOps\(\)/);
    expect(view).not.toMatch(/useCanWrite\(\)/);
  });
});

describe("the words on it", () => {
  it("name what a job IS, not what the column calls it", () => {
    expect(jobLabel("quote_email")).toBe("Quotation email");
    expect(jobLabel("booking_email")).toBe("Booking confirmation");
  });

  it("falls back to the handler rather than to 'Unknown'", () => {
    /* A row this map has not been taught about is still something an admin can
       search for and ask about. "Unknown" throws away the one fact the screen
       actually has. */
    expect(jobLabel("something_new")).toBe("something_new");
  });

  it("COVERS EVERY HANDLER THE PRODUCT CAN QUEUE", async () => {
    /*
       Checked against the real registry rather than trusted. A handler added
       without a label here would reach an IT admin as `booking_email`, which is
       this product's internal vocabulary showing through on the one screen
       whose whole job is to be legible to somebody under pressure.
    */
    const { OUTBOX_REGISTRY } = await import("@/server/outbox-handlers");
    for (const handler of Object.keys(OUTBOX_REGISTRY)) {
      expect(JOB_LABELS[handler], `${handler} has no human name in data/jobs.ts`).toBeTruthy();
    }
  });
});
