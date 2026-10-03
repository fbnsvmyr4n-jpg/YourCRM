"use client";

import { createContext, useContext } from "react";

/**
 * May the person looking at this screen change anything?
 *
 * One answer, read on the server by the layout that wraps every page and handed
 * down — the same shape as `CurrencyProvider`, and for the same reason: a
 * button three levels deep should be able to ask, rather than every screen
 * threading a prop through its children.
 *
 * ── Why it exists ─────────────────────────────────────────────────────────
 *
 * A view-only user was offered every write control in the product. Add New
 * Lead, Compose Email, Schedule Meeting, every Edit and every status menu —
 * all of them submitted, and all of them were refused by the database, which
 * is the correct and final answer. But `permissions.ts` names that exact
 * shape as the failure to avoid: "a button that is visible, submits, and is
 * refused". Offering somebody work the product will not accept wastes their
 * time and makes a working product look broken.
 *
 * ── What this is NOT ──────────────────────────────────────────────────────
 *
 * It is not security. `withCurrentTenant` opens a read-only transaction for a
 * viewer and Postgres refuses the write, whatever this returns, and that is
 * what actually protects the data. This only stops the product offering what
 * it will not honour.
 *
 * ── Why it defaults to true ───────────────────────────────────────────────
 *
 * Fail-OPEN, which looks wrong and is right: the default is for components
 * rendered outside the app shell — the public booking page, the enquiry form,
 * the pay page — where there is no session and no viewer, and where hiding the
 * only button on the screen would break a stranger's booking. The one thing
 * standing between a viewer and a write is the database, not this.
 */
const CanWriteContext = createContext<boolean>(true);

export function CanWriteProvider({ canWrite, children }: { canWrite: boolean; children: React.ReactNode }) {
  return <CanWriteContext.Provider value={canWrite}>{children}</CanWriteContext.Provider>;
}

/** True unless this reader is view-only. */
export function useCanWrite(): boolean {
  return useContext(CanWriteContext);
}
