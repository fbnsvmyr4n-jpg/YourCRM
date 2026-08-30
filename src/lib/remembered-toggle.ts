"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * An open/closed choice that survives a reload.
 *
 * Lifted out of `MobileSection` so a second fold — Contact Activity on the
 * contacts page — can have the same memory without a second copy of the subtle
 * part. The markup around a fold is site-specific: the dashboard collapses at
 * `sm`, the contact panel at the width where Status stops having its own
 * column. The REMEMBERING is not, and is exactly the bit worth having one of.
 *
 * It remembers because otherwise a fold is a tax rather than a tidy-up.
 * Somebody who opens a section every time they land on a page was re-opening it
 * every time; the choice belongs to the reader, and making them repeat it is the
 * app being tidy at their expense.
 *
 * `useSyncExternalStore` rather than an effect writing state. Stored
 * preferences ARE an external mutable source, which is what the hook exists
 * for, and it keeps the server and client snapshots explicitly separate — the
 * server has no `localStorage`, so it renders the default and the client reads
 * the real value on hydration with no mismatch and no cascading render. Setting
 * state inside an effect to do the same job is what the React compiler rejects,
 * and it is right to.
 *
 * @param key a namespaced storage key, e.g. `dash-open:revenue`
 */
export function useRememberedToggle(
  key: string,
  defaultOpen: boolean
): readonly [boolean, () => void] {
  const open = useSyncExternalStore(
    subscribe,
    () => read(key, defaultOpen),
    () => defaultOpen
  );
  const toggle = useCallback(() => write(key, !read(key, defaultOpen)), [key, defaultOpen]);
  return [open, toggle] as const;
}

/*
   A tiny store over `localStorage`, shared by every toggle on the page.

   Every access is guarded. Private windows, cleared site data and browsers set
   to block site data all THROW here rather than returning null, and a page must
   not fail to render because a preference could not be read. Losing the memory
   is a small thing; losing the page is not.
*/
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  /* Another tab is a legitimate second writer, and `storage` only fires there —
     never in the tab that made the change, which is why writes below notify the
     local listeners by hand. */
  const onStorage = () => onChange();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

function read(key: string, fallback: boolean): boolean {
  try {
    const saved = window.localStorage.getItem(key);
    return saved === null ? fallback : saved === "1";
  } catch {
    return fallback;
  }
}

function write(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* Not being able to remember is not a reason to refuse to open. */
  }
  for (const listener of listeners) listener();
}
