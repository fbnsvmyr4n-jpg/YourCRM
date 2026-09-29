import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What the audit log promises, against what it records.
 *
 * The card says: "Every change made in this workspace from now on is listed
 * here — who made it, to which record, and when." That sentence was not true.
 * Changing the workspace's revenue target recorded nothing; so did inviting a
 * colleague, changing somebody's role, and removing their access — the three
 * events an audit log most exists for. They ran through `withSystem`, because
 * `users` is an agency-level table, and `logWrite` inside a system transaction
 * had nowhere to put its entry, so it was dropped on the floor.
 *
 * Found on 2026-09-29 by changing a setting in the running app and then
 * looking at the audit log, which was still empty.
 *
 * A source-level guard rather than a database one: what went wrong was a call
 * site that was never written, and no amount of exercising the ones that exist
 * would have found it.
 */

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const bodyOf = (src: string, name: string) => {
  const start = src.indexOf(`export async function ${name}`);
  if (start < 0) return null;
  const next = src.indexOf("\nexport ", start + 1);
  return src.slice(start, next < 0 ? undefined : next);
};

/**
 * Actions that change something a person would later ask "who did that?" about.
 *
 * Deliberately a list rather than "every action": a redirect to Stripe and a
 * workspace switch change nothing, and demanding an entry for them would teach
 * the next person to add one meaninglessly.
 */
const MUST_RECORD: { file: string; action: string; why: string }[] = [
  {
    file: "src/app/(app)/settings/team-actions.ts",
    action: "inviteMemberAction",
    why: "somebody gained access to the workspace",
  },
  {
    file: "src/app/(app)/settings/team-actions.ts",
    action: "setMemberRoleAction",
    why: "somebody's permissions changed",
  },
  {
    file: "src/app/(app)/settings/team-actions.ts",
    action: "removeMemberAction",
    why: "somebody lost access to the workspace",
  },
  {
    file: "src/app/(app)/settings/team-actions.ts",
    action: "updateStaffAction",
    why: "somebody else's record was edited",
  },
  {
    file: "src/app/(app)/settings/actions.ts",
    action: "updateTargetsAction",
    why: "the figures every report is measured against changed",
  },
  {
    file: "src/app/(app)/settings/actions.ts",
    action: "changePasswordAction",
    why: "a credential changed — the fact of it, never the value",
  },
  {
    file: "src/app/(app)/settings/actions.ts",
    action: "restoreDeletedAction",
    why: "a deleted record came back, and the delete itself is recorded",
  },
];

describe("the audit log records what it says it records", () => {
  for (const { file, action, why } of MUST_RECORD) {
    it(`${action} — ${why}`, () => {
      const body = bodyOf(read(file), action);
      expect(body, `${action} is not in ${file} any more — update this list`).not.toBeNull();
      expect(body!, `${action} changes something and records nothing`).toMatch(/logWrite\(/);
    });
  }

  it("A SYSTEM TRANSACTION CAN REACH THE WORKSPACE'S LOG — otherwise team changes vanish", () => {
    /* `users` is agency-level, so team actions cannot run under `withTenant`.
       Without this, `logWrite` in one of them writes to stdout and nowhere
       else, and the workspace's own log never sees the most important
       events it has. */
    const tenant = read("src/server/tenant.ts");
    expect(tenant).toMatch(/export async function withSystem<T>\([\s\S]*?auditFor\?: TenantContext/);
    expect(tenant, "entries collected in a system transaction are never written").toMatch(
      /await writeAudit\(client, auditFor, entries\)/
    );
  });

  it("the team actions actually pass their workspace, or the entries go nowhere", () => {
    const team = read("src/app/(app)/settings/team-actions.ts");
    /* Each audited block closes with `}, me)` — the tenant context the entry
       is filed under. Three of them: role, removal, directory entry. */
    const wired = [...team.matchAll(/\}, me\);/g)].length;
    expect(wired, "a team action logs a change into a transaction with no workspace").toBeGreaterThanOrEqual(3);
  });

  it("never records the value of a credential, only that one changed", () => {
    const body = bodyOf(read("src/app/(app)/settings/actions.ts"), "changePasswordAction")!;
    const call = /logWrite\([^)]*\)/.exec(body)?.[0] ?? "";
    for (const leak of ["current", "next", "confirm", "hash", "password:"]) {
      expect(call, `the password audit entry carries "${leak}"`).not.toContain(leak);
    }
  });
});
