import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { canAccessCrm, CAPABILITIES, can, outranks } from "../src/server/permissions";
import { ROLES } from "../src/server/tenant";

/**
 * Who may read a customer's records.
 *
 * IT and accounts run the account; they have no business reading a customer's
 * phone number. The rule is one line in `permissions.ts` — the work is making
 * sure nothing routes around it, which is why most of this file reads source
 * rather than calling functions.
 *
 * A static test on purpose, and for the reason the authorisation suite gives:
 * an exploit test proves a hole exists once, this proves no hole exists every
 * time it runs. The failure it guards against is not a wrong answer, it is a
 * new server action written next month by somebody who has never opened
 * `permissions.ts`.
 */

const ROOT = join(__dirname, "..");
const APP = join(ROOT, "src", "app");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

const sources = walk(APP).map((path) => ({
  path: relative(ROOT, path),
  src: readFileSync(path, "utf8"),
}));

describe("the rule itself", () => {
  it("lets the owner and the people doing the selling in", () => {
    expect(canAccessCrm("owner")).toBe(true);
    expect(canAccessCrm("member")).toBe(true);
  });

  it("keeps IT and accounts out", () => {
    expect(canAccessCrm("admin"), "IT could read customer records").toBe(false);
    expect(canAccessCrm("finance"), "accounts could read customer records").toBe(false);
  });

  it("fails closed for a role nobody recognises", () => {
    // The value arrives from a database column and is really whatever is in
    // that column — a typo in a migration, a row from an older schema.
    expect(canAccessCrm("superuser")).toBe(false);
    expect(canAccessCrm("")).toBe(false);
  });

  /**
   * The reason this is not a capability, pinned so it cannot quietly become one.
   *
   * `outranks` compares two roles by asking whether one holds every capability
   * the other does. Had CRM access been added to CAPABILITIES, a member would
   * hold something an admin does not — and an admin would no longer be able to
   * manage a member. The entire people-management screen would have stopped
   * working for the role that exists to run it.
   */
  it("is kept out of the ranked capabilities, so admins can still manage members", () => {
    expect(CAPABILITIES as readonly string[]).not.toContain("access_crm");
    expect(outranks("admin", "member"), "an admin could no longer manage a member").toBe(true);
    expect(outranks("owner", "member")).toBe(true);
  });

  it("is orthogonal to rank, not a tier of it", () => {
    // A member outranks nobody and sees everything; an admin outranks members
    // and sees nothing. If these two ever agree, the split has collapsed.
    const ranked = (role: string) => CAPABILITIES.filter((c) => can(role as never, c)).length;
    expect(ranked("admin")).toBeGreaterThan(ranked("member"));
    expect(canAccessCrm("admin")).toBe(false);
    expect(canAccessCrm("member")).toBe(true);
  });
});

describe("nothing routes around the gate", () => {
  it("finds the application sources (a suite matching nothing proves nothing)", () => {
    expect(sources.length).toBeGreaterThan(20);
  });

  /**
   * Opting out of the customer-data gate, each with a reason.
   *
   * `crmData: false` says "this touches no customer records". It is the one way
   * past the gate, so every use of it is listed here and justified — the same
   * arrangement as `allowInactive` on the plan gate, and for the same reason:
   * an escape hatch nobody has to explain is one that gets used because it made
   * an error go away.
   */
  const OPT_OUTS: Record<string, string> = {
    "src/app/(app)/layout.tsx":
      "wraps every page in the group, Settings included. Gated it would redirect " +
      "an IT admin to Settings, whose layout would redirect them again. It fetches " +
      "notifications and nav counts only when the reader has CRM access anyway.",
    "src/app/(app)/settings/page.tsx":
      "the one screen IT and accounts can open. It earns the opt-out by skipping " +
      "the bin and the book of business for a reader without CRM access, rather " +
      "than fetching them and hiding them.",
    "src/app/(app)/settings/actions.ts":
      "updateTargetsAction only — a revenue target and a weekly capacity are " +
      "numbers the business chooses about itself, not records about a customer. " +
      "restoreDeletedAction in the same file is deliberately left gated, because " +
      "what it puts back is contacts, deals and meetings.",
  };

  it("only the listed files opt out", () => {
    const optingOut = sources
      .filter(({ src }) => /crmData:\s*false/.test(src))
      .map(({ path }) => path);

    for (const path of optingOut) {
      expect(
        OPT_OUTS[path],
        `${path} opts out of the customer-data gate with no reason recorded. ` +
          `Add it to OPT_OUTS with why, or remove the opt-out.`
      ).toBeTruthy();
    }
  });

  it("every listed opt-out is still real", () => {
    // An excuse for something that no longer happens is worse than no excuse:
    // it reads as a decision somebody made and silences the check.
    for (const path of Object.keys(OPT_OUTS)) {
      const file = sources.find((s) => s.path === path);
      expect(file, `${path} is listed as opting out but was not found`).toBeTruthy();
      expect(
        /crmData:\s*false/.test(file!.src),
        `${path} no longer opts out — remove it from OPT_OUTS`
      ).toBe(true);
    }
  });

  /**
   * The gate defaults to REQUIRED, which is the whole design.
   *
   * If `withCurrentTenant` ever stops demanding CRM access unless told
   * otherwise, every one of the forty-odd actions that never mentions it
   * silently opens up, and nothing else in this suite would notice.
   */
  it("the shared entry points require access unless told otherwise", () => {
    const session = readFileSync(join(ROOT, "src", "server", "tenant-session.ts"), "utf8");
    expect(
      session,
      "withCurrentTenant no longer defaults to requiring CRM access"
    ).toMatch(/options\.crmData !== false && !canAccessCrm\(ctx\.role\)/);
    expect(session, "withTenantPage no longer redirects a reader without access").toMatch(
      /options\.crmData !== false && !canAccessCrm\(user\.role\)/
    );
  });

  it("the refusal is a named error, so a route can answer 403 rather than 500", () => {
    const session = readFileSync(join(ROOT, "src", "server", "tenant-session.ts"), "utf8");
    expect(session).toMatch(/export class CrmAccessError/);
  });
});

describe("the sidebar agrees with the server", () => {
  const nav = readFileSync(join(ROOT, "src", "components", "shell", "nav.ts"), "utf8");

  it("hides everything except the account screens", async () => {
    const { visibleNav, NAV } = await import("../src/components/shell/nav");
    const hrefs = visibleNav(false).flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs.sort()).toEqual(["/settings", "/support"]);

    // And the full list is genuinely bigger, so the assertion above is not
    // passing because the nav happens to be tiny.
    expect(NAV.flatMap((s) => s.items).length).toBeGreaterThan(5);
  });

  it("shows everything to somebody with access", async () => {
    const { visibleNav, NAV } = await import("../src/components/shell/nav");
    expect(visibleNav(true)).toEqual(NAV);
  });

  it("drops sections that empty out rather than leaving a bare heading", async () => {
    const { visibleNav } = await import("../src/components/shell/nav");
    for (const section of visibleNav(false)) {
      expect(section.items.length).toBeGreaterThan(0);
    }
  });

  it("a new page is hidden by default rather than exposed", () => {
    // `needsCrm` is absent on everything that shows customer records, and only
    // the two account screens say `needsCrm: false`. Written the other way round
    // — an opt-IN flag — a page added without the flag would be visible to IT.
    const exemptions = [...nav.matchAll(/needsCrm:\s*false/g)].length;
    expect(exemptions, "more screens are exempt than the two account ones").toBe(2);
  });
});

describe("every role is still coherent", () => {
  it("has a decision recorded for CRM access", () => {
    // A role added to ROLES without an entry in the access table would fall to
    // the `?? false` fallback, which is safe but silent. This makes the silence
    // audible: every role must be a deliberate true or false.
    const permissions = readFileSync(join(ROOT, "src", "server", "permissions.ts"), "utf8");
    const table = permissions.slice(
      permissions.indexOf("const CRM_ACCESS"),
      permissions.indexOf("};", permissions.indexOf("const CRM_ACCESS"))
    );
    for (const role of ROLES) {
      expect(table, `no CRM_ACCESS entry for "${role}"`).toMatch(
        new RegExp(`${role}:\\s*(true|false)`)
      );
    }
  });
});
