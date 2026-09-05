import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CAPABILITIES, can, outranks, roleCan } from "../src/server/permissions";
import { ROLES } from "../src/server/tenant";

/**
 * Who may do what.
 *
 * The audit's central finding was that 31 server actions reached production
 * without an authorisation check, because the check was something a developer
 * had to remember. The same shape appeared again here: the first version of
 * `createWorkspaceAction` compared the role inline, and every mutation of that
 * comparison passed the whole suite — nothing was watching it.
 */

describe("roles grant what they should, and nothing more", () => {
  it("a member cannot add workspaces, colleagues, or touch billing", () => {
    for (const capability of CAPABILITIES) {
      expect(can("member", capability), `member was granted ${capability}`).toBe(false);
    }
  });

  it("an owner can do everything there is", () => {
    for (const capability of CAPABILITIES) {
      expect(can("owner", capability), `owner was denied ${capability}`).toBe(true);
    }
  });

  it("an admin runs the agency but does not see the card details", () => {
    expect(can("admin", "manage_workspaces")).toBe(true);
    expect(can("admin", "manage_users")).toBe(true);
    // Billing is the owner's. An admin is trusted with the work, not with the
    // means to change what the business pays.
    expect(can("admin", "manage_billing")).toBe(false);
  });

  it("every role has an explicit answer for every capability", () => {
    /**
     * A new role added to the enum with no entry here would silently inherit
     * whatever `??` produced. Making the matrix total means adding a role is a
     * decision somebody has to write down.
     */
    for (const role of ROLES) {
      for (const capability of CAPABILITIES) {
        expect(typeof can(role, capability), `${role} × ${capability} is undecided`).toBe("boolean");
      }
    }
  });

  it("an unrecognised role grants nothing", () => {
    // Roles arrive from a database column. A value nobody anticipated — a typo
    // in a migration, an old row — must fail closed.
    for (const capability of CAPABILITIES) {
      expect(roleCan("superuser", capability)).toBe(false);
      expect(roleCan("", capability)).toBe(false);
      expect(roleCan("OWNER", capability), "role matching is case sensitive").toBe(false);
    }
  });

  it("a known role behaves the same through either entry point", () => {
    for (const role of ROLES) {
      for (const capability of CAPABILITIES) {
        expect(roleCan(role, capability)).toBe(can(role, capability));
      }
    }
  });
});

/**
 * Who may administer whom.
 *
 * `outranks` is what stopped `role !== "owner"` from being written out five
 * times across the team screen and its actions. The rule it encodes is not
 * "owner beats admin" — that is only what falls out of the current matrix. It
 * is "you may act on somebody only if you hold every capability they hold", so
 * a fourth role, or a capability moving between roles, changes the answer here
 * without anybody editing a comparison.
 */
describe("the accounts department", () => {
  /*
     `finance` exists because billing used to be owner-only and owner grants
     everything else too — so letting a bookkeeper pay an invoice meant handing
     them the power to remove the CEO.
  */
  it("can touch the money and nothing else", () => {
    expect(can("finance", "manage_billing")).toBe(true);
    expect(can("finance", "manage_users"), "finance could add colleagues").toBe(false);
    expect(can("finance", "manage_workspaces"), "finance could add workspaces").toBe(false);
  });

  it("is administered by an owner and by nobody else", () => {
    // Emergent, not special-cased: an admin does not hold `manage_billing`, so
    // `outranks` refuses. Nothing anywhere says "admins may not touch finance".
    expect(outranks("owner", "finance")).toBe(true);
    expect(outranks("admin", "finance"), "an admin could remove the bookkeeper").toBe(false);
    expect(outranks("member", "finance")).toBe(false);
  });

  it("cannot administer anybody, including another finance user", () => {
    // They hold a capability the others lack, so they never outrank an admin —
    // and `manage_users` is what actually gates the screen anyway.
    expect(outranks("finance", "admin")).toBe(false);
    expect(outranks("finance", "owner")).toBe(false);
    expect(roleCan("finance", "manage_users")).toBe(false);
  });

  it("is not offered by an admin inviting somebody", () => {
    // The Team screen builds its list as ROLES.filter(r => outranks(me, r)),
    // so an admin cannot hand out a role they could not then manage.
    const offeredByAdmin = ROLES.filter((r) => outranks("admin", r));
    expect(offeredByAdmin).not.toContain("finance");
    expect(ROLES.filter((r) => outranks("owner", r))).toContain("finance");
  });
});

describe("the order of ROLES is load-bearing", () => {
  /*
     The Team screen takes the default for a new colleague from the LAST role it
     may offer. Alphabetise this array and an invitation quietly defaults to
     "admin" — a change with no type error, no failing assertion anywhere else,
     and a real consequence.
  */
  it("runs most powerful to least", () => {
    const weight = (role: string) => CAPABILITIES.filter((c) => roleCan(role, c)).length;
    const weights = ROLES.map(weight);
    expect(weights).toEqual([...weights].sort((a, b) => b - a));
  });

  it("ends on a role that grants nothing, whoever is inviting", () => {
    for (const inviter of ROLES) {
      const offered = ROLES.filter((r) => outranks(inviter, r));
      if (offered.length === 0) continue;
      const fallback = offered[offered.length - 1];
      expect(
        CAPABILITIES.every((c) => !roleCan(fallback, c)),
        `${inviter} would invite somebody as "${fallback}" by default`
      ).toBe(true);
    }
  });
});

describe("administering a colleague", () => {
  it("an owner may act on anyone, including another owner", () => {
    for (const role of ROLES) {
      expect(outranks("owner", role), `owner could not act on ${role}`).toBe(true);
    }
  });

  it("an admin may act on an admin or a member, but not on an owner", () => {
    expect(outranks("admin", "member")).toBe(true);
    expect(outranks("admin", "admin")).toBe(true);
    expect(outranks("admin", "owner"), "an admin could remove the owner who pays").toBe(false);
  });

  it("holds for every pair, derived from the matrix rather than listed", () => {
    // The property, stated once: outranking means holding a superset of the
    // other's capabilities. Any pair that disagrees is a bug in `outranks` or
    // an unnoticed change in the grants.
    for (const viewer of ROLES) {
      for (const target of ROLES) {
        const superset = CAPABILITIES.every((c) => !can(target, c) || can(viewer, c));
        expect(outranks(viewer, target), `${viewer} vs ${target}`).toBe(superset);
      }
    }
  });

  it("never grants on its own — a member outranks a member and still may not manage", () => {
    // The two checks are separate on purpose. This one answers "may I act on
    // THEM"; `manage_users` answers "may I act on anyone at all".
    expect(outranks("member", "member")).toBe(true);
    expect(roleCan("member", "manage_users")).toBe(false);
  });

  it("an unknown role can act on nobody who holds anything", () => {
    // A role from a bad migration grants nothing, so it holds no capability and
    // cannot be a superset of one that does. Fail closed, like `can`.
    expect(outranks("superadmin", "member")).toBe(true);
    expect(outranks("superadmin", "admin")).toBe(false);
    expect(outranks("superadmin", "owner")).toBe(false);
  });
});

describe("the permission is checked where the work happens", () => {
  const APP = join(__dirname, "..", "src", "app");

  const walk = (dir: string): string[] =>
    !existsSync(dir)
      ? []
      : readdirSync(dir).flatMap((f) => {
          const full = join(dir, f);
          if (statSync(full).isDirectory()) return walk(full);
          return f.endsWith(".ts") || f.endsWith(".tsx") ? [full] : [];
        });

  const sources = walk(APP).map((path) => ({ path, src: readFileSync(path, "utf8") }));

  it("finds the application sources (a suite matching nothing proves nothing)", () => {
    expect(sources.length).toBeGreaterThan(10);
  });

  /**
   * Roles are compared through `permissions.ts`, never inline.
   *
   * An inline `role !== "member"` in an action and a different inline test in
   * the component that renders the button are two rules that drift, and the
   * drift is invisible until somebody is either refused a button they can see
   * or handed one they should not have.
   */
  it("no page or action compares a role by hand", () => {
    for (const { path, src } of sources) {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const role of ROLES) {
        const inline = new RegExp(`\\brole\\s*[!=]==\\s*["']${role}["']`);
        expect(
          inline.test(code),
          `${path.split("/app/")[1]} compares a role inline against "${role}" — ` +
            `use roleCan() so the action and the UI cannot disagree`
        ).toBe(false);
      }
    }
  });

  it("the workspace action refuses anyone without the capability", () => {
    const src = readFileSync(join(APP, "(app)", "settings", "actions.ts"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const body = code.slice(code.indexOf("export async function createWorkspaceAction"));

    expect(body, "createWorkspaceAction does not check the role at all").toMatch(
      /roleCan\(\s*me\.role\s*,\s*"manage_workspaces"\s*\)/
    );
    // Before the write, not after it. A check that runs once a row exists is
    // not a check, it is a log line.
    expect(body.indexOf("manage_workspaces")).toBeLessThan(body.indexOf("createSubAccount(q"));
  });
});
