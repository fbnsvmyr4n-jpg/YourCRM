"use client";

import { createContext, useContext } from "react";

/**
 * What this reader may DO, per door.
 *
 * `CanWrite` answers one question — may they change customer records — and for
 * a while that was the only question any screen asked. It stopped being enough
 * the moment the tiers split three ways, and the way it failed is worth
 * keeping: `canWrite` is false for finance, correctly, because a bookkeeper has
 * no business in the pipeline. Screens then used it as "may this person do
 * anything at all", so a finance user got an inbox they could read and not
 * reply from, and a price list they could read and not load a supplier's sheet
 * into. Both are their job.
 *
 * So each door has its own answer, and a screen asks the one that matches what
 * it is: a mail screen asks about mail, a money screen asks about money.
 *
 * ── Why these also check view-only ────────────────────────────────────────
 *
 * A viewer holds every tier and writes nothing. Folding that in here means a
 * screen asks one question instead of two and cannot get the pair half right.
 *
 * ── What this is NOT ──────────────────────────────────────────────────────
 *
 * Not security, exactly like `CanWrite`. `withCurrentTenant` refuses at the
 * door and Postgres refuses a viewer's write whatever any of this returns.
 * This only stops the product offering what it will not honour.
 */
type Abilities = {
  /** May write mail: reply, forward, compose, bin. */
  mail: boolean;
  /** May act on money: load a supplier's prices, keep the price list. */
  money: boolean;
};

/*
   Both default TRUE, for the same fail-open reason `CanWrite` does: the
   default serves components rendered outside the app shell, where there is no
   session and no role. The database is what stands between anybody and a
   write.
*/
const AbilitiesContext = createContext<Abilities>({ mail: true, money: true });

export function AbilitiesProvider({
  mail,
  money,
  children,
}: Abilities & { children: React.ReactNode }) {
  return <AbilitiesContext.Provider value={{ mail, money }}>{children}</AbilitiesContext.Provider>;
}

/** May this reader write mail — reply, forward, compose, bin a message. */
export function useCanWriteMail(): boolean {
  return useContext(AbilitiesContext).mail;
}

/** May this reader act on money — keep the price list, load a supplier's sheet. */
export function useCanHandleMoney(): boolean {
  return useContext(AbilitiesContext).money;
}
