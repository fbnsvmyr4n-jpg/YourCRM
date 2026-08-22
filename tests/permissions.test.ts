import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CAPABILITIES, can, roleCan } from "../src/server/permissions";
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
