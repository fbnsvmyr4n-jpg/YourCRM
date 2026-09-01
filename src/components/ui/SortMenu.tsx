"use client";

import { useState } from "react";
import { ArrowUpDown, Check } from "lucide-react";
import { clsx } from "@/lib/clsx";
import { AnchoredMenu } from "./AnchoredMenu";

/**
 * The sort control, once.
 *
 * There were no sort controls on any of twelve screens — invisible at ten
 * records and unusable at five hundred, which is what a CSV import produces on
 * day one. Four lists needed the same menu, and four copies would have drifted:
 * one would keep its dropdown open on Escape, another would forget to mark the
 * current option, and the difference would only ever be noticed by whoever used
 * the odd one out.
 *
 * The options themselves stay with each list — what "most valuable" means to a
 * lead is not what it means to a message, and a generic list of orderings would
 * be a lie in at least one place.
 */

export type SortOption<T extends string> = { id: T; label: string };

export function SortMenu<T extends string>({
  options,
  value,
  onChange,
  /** The order that counts as "no sort applied", so the button stays quiet. */
  defaultId,
  label = "Sort",
}: {
  options: readonly SortOption<T>[];
  value: T;
  onChange: (next: T) => void;
  defaultId: T;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  /* The button itself is the anchor, so the menu is positioned from where it
     actually is rather than from a wrapper that may be laid out elsewhere. */
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);

  const active = value !== defaultId;

  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={label}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="menu"
        className={clsx(
          "focus-ring grid h-9 w-9 place-items-center rounded-full transition-colors",
          // Lit only when something other than the default is chosen, so the
          // control says at a glance whether the list is in an unusual order.
          active ? "text-accent" : "btn-soft text-muted"
        )}
        style={active ? { background: "var(--accent-soft)" } : undefined}
      >
        <ArrowUpDown className="h-4 w-4" />
      </button>

      <AnchoredMenu anchor={anchor} open={open} onClose={() => setOpen(false)} width={208}>
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="menuitemradio"
            aria-checked={value === o.id}
            onClick={() => {
              onChange(o.id);
              setOpen(false);
            }}
            className={clsx(
              "flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--raise)]",
              value === o.id && "text-accent"
            )}
          >
            {o.label}
            {value === o.id && <Check className="h-3.5 w-3.5" />}
          </button>
        ))}
      </AnchoredMenu>
    </>
  );
}
