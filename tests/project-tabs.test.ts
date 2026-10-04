/*
   The job page's tabs are declared in two files on purpose — the ids where the
   server can read them, the labels and icons beside the buttons that draw them.
   Two lists is two lists, so these hold them to each other: a tab added to the
   row and not to the ids is a tab no link can open, and an id with no button is
   an address that opens a job on nothing.

   The defect this was written for: a quotation's "Open job" link had said
   `?tab=documents` since the day it was written, and nothing read it. The page
   opened on Team every time, so the one link whose whole purpose was to land on
   the documents landed somewhere else.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_TAB, isProjectTab, PROJECT_TABS } from "@/app/(app)/projects/[id]/tabs";

const dir = join(process.cwd(), "src/app/(app)/projects/[id]");
const detail = readFileSync(join(dir, "ProjectDetail.tsx"), "utf8");
const page = readFileSync(join(dir, "page.tsx"), "utf8");
const sheet = readFileSync(join(process.cwd(), "src/app/(app)/documents/[id]/DocumentSheet.tsx"), "utf8");

/** The ids in the TABS array the tab row is drawn from. */
function drawnTabs() {
  const block = detail.match(/const TABS = \[([\s\S]*?)\] as const;/);
  expect(block, "ProjectDetail still declares its TABS array").toBeTruthy();
  return [...block![1].matchAll(/id: "([a-z]+)"/g)].map((m) => m[1]);
}

describe("the job page's tabs", () => {
  it("draws a button for every id, and no button without one", () => {
    expect(drawnTabs()).toEqual([...PROJECT_TABS]);
  });

  it("opens on a tab that exists", () => {
    expect(isProjectTab(DEFAULT_PROJECT_TAB)).toBe(true);
  });

  it("recognises every tab, and nothing else", () => {
    for (const id of PROJECT_TABS) expect(isProjectTab(id)).toBe(true);
    // An address is typed, shared and bookmarked by anyone.
    for (const junk of ["", "TEAM", "invoices", "../team", null, undefined, 3, {}]) {
      expect(isProjectTab(junk)).toBe(false);
    }
  });
});

describe("a link that names a tab", () => {
  it("is read by the page rather than ignored", () => {
    expect(page).toMatch(/searchParams/);
    expect(page).toMatch(/isProjectTab\(tab\)/);
    expect(page).toMatch(/initialTab=\{initialTab\}/);
  });

  it("decides where the tab row starts", () => {
    expect(detail).toMatch(/useState<TabId>\(initialTab\)/);
  });

  it("is what a document's Open job link asks for", () => {
    const asked = sheet.match(/\/projects\/\$\{doc\.dealId\}\?tab=([a-z]+)/);
    expect(asked, "the document still links to its job").toBeTruthy();
    expect(isProjectTab(asked![1])).toBe(true);
  });
});
