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
 */
export function useOpenFromQuery(param: string, open: () => void): void {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    if (params.get(param) !== "1") return;
    fired.current = true;

    open();

    const next = new URLSearchParams(params.toString());
    next.delete(param);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [params, param, open, router, pathname]);
}
