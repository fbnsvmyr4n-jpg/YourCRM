"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Opens something because a quick action asked for it.
 *
 * Quick Actions on the dashboard link to e.g. `/leads?new=1` rather than
 * `/leads`, so the user lands on the form itself instead of the page and then
 * having to hunt for the button.
 *
 * The flag is stripped from the URL immediately afterwards, via `replace` so
 * it leaves no history entry. Without that, a refresh or a back-navigation
 * would silently reopen the form, and the URL would keep advertising a
 * one-shot intent as though it were page state.
 *
 * Guarded by a ref so React's development double-invoke doesn't fire it twice.
 *
 * `carries` names parameters the intent brings WITH it — `?compose=1&to=…`,
 * which is how Email on a contact card opens the composer already addressed.
 * They are handed to the callback and stripped alongside the flag, because a
 * half-cleared URL is the same one-shot-intent-as-page-state problem the strip
 * exists to prevent: refresh, and the composer reopens addressed to somebody.
 */
export function useOpenFromQuery(
  param: string,
  open: (carried: Record<string, string>) => void,
  carries: readonly string[] = []
): void {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const fired = useRef(false);

  useEffect(() => {
    /*
       Reset when the flag is gone, rather than latching for the life of the
       component.

       The ref is here for React's development double-invoke, and as a permanent
       latch it also swallowed every SECOND request on a page that never
       unmounts. That is not hypothetical any more: Email on an inbox card links
       to `/inbox?compose=1&to=…`, so the route does not change and the view does
       not remount — the first press opened the composer and every one after it
       did nothing at all.

       Because the flag is stripped immediately below, "absent" is the state
       between two intents, which makes it exactly the right moment to re-arm.
    */
    if (params.get(param) !== "1") {
      fired.current = false;
      return;
    }
    if (fired.current) return;
    fired.current = true;

    const carried: Record<string, string> = {};
    for (const name of carries) {
      const value = params.get(name);
      if (value !== null) carried[name] = value;
    }

    open(carried);

    const next = new URLSearchParams(params.toString());
    next.delete(param);
    for (const name of carries) next.delete(name);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    /* `carries` is a literal at every call site, so it is intentionally not a
       dependency — including it would re-run this on every render. The `fired`
       ref makes a second run a no-op anyway. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, param, open, router, pathname]);
}
