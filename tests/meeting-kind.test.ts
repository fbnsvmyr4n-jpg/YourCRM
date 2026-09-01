import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { kindFromLabel, KINDS } from "../src/server/repos/meetings";

/**
 * The word the screen says, and the word the database stores.
 *
 * The meetings table stores `online` / `in_person`. Every screen says "Online"
 * and "In-Person". Both meeting forms posted the LABEL into a field validated
 * against the stored values with an exact, case-sensitive match, so it resolved
 * to null and the action bailed out.
 *
 * The damage was quiet and total: booking through the scheduler created nothing
 * at all — the request returned 200 and no meeting existed — and rescheduling
 * refused with "Check the name, date and format." on a form where the name, the
 * date and the format were all plainly correct. Found by testing the three
 * controls on the upcoming list rather than by reading the code.
 */

describe("reading a meeting format from a form", () => {
  it("accepts the labels the forms actually post", () => {
    expect(kindFromLabel("Online")).toBe("online");
    expect(kindFromLabel("In-Person")).toBe("in_person");
  });

  it("still accepts the stored values unchanged", () => {
    /* So the same field takes either vocabulary, and a caller that already has
       a stored value does not have to translate it back first. */
    for (const k of KINDS) expect(kindFromLabel(k)).toBe(k);
  });

  it("is not fussy about case or spacing", () => {
    expect(kindFromLabel("  online  ")).toBe("online");
    expect(kindFromLabel("IN-PERSON")).toBe("in_person");
    expect(kindFromLabel("in person")).toBe("in_person");
  });

  it("refuses anything else rather than guessing", () => {
    /* A wrong format silently stored is a meeting that shows the wrong thing
       forever; the action turning it away is the correct outcome. */
    expect(kindFromLabel("Zoom")).toBeNull();
    expect(kindFromLabel("")).toBeNull();
    expect(kindFromLabel(null)).toBeNull();
    expect(kindFromLabel(undefined)).toBeNull();
    expect(kindFromLabel(42)).toBeNull();
    expect(kindFromLabel({ kind: "online" })).toBeNull();
  });
});

describe("both meeting forms go through it", () => {
  const actions = readFileSync(
    fileURLToPath(new URL("../src/app/(app)/meetings/actions.ts", import.meta.url)),
    "utf8"
  );

  it("uses the translation, not a raw exact match", () => {
    /* Booking and rescheduling both read this field, and both were broken by
       the same line. Asserted on both so fixing one and not the other cannot
       pass. */
    const uses = actions.match(/kindFromLabel\(formData\.get\("type"\)\)/g) ?? [];
    expect(uses).toHaveLength(2);
    expect(actions).not.toMatch(/pick\(formData\.get\("type"\), KINDS\)/);
  });
});
