/*
   The job page's tab ids, in their own file so the SERVER can read them.

   The page is a server component and the tab row is a client one. A client
   module's exports are client references on the server — importing the tab
   list from `ProjectDetail` to validate an address would not give the server a
   function it can call. The ids are the only part the server needs, so they
   live here; the labels and icons stay beside the buttons that draw them, and
   `project-tabs.test.ts` holds the two lists to each other.
*/

export const PROJECT_TABS = ["team", "timeline", "documents", "threads", "history"] as const;

export type ProjectTabId = (typeof PROJECT_TABS)[number];

export const DEFAULT_PROJECT_TAB: ProjectTabId = "team";

/**
 * Is this one of the tabs the job page has.
 *
 * The tab can be named in the address — a quotation's "Open job" link asks for
 * the documents tab — and an address is typed, shared and bookmarked by
 * anyone. Checked against the list rather than cast, so a stale or hand-edited
 * link opens the job on its first tab instead of on no tab at all.
 */
export function isProjectTab(value: unknown): value is ProjectTabId {
  return (PROJECT_TABS as readonly unknown[]).includes(value);
}
