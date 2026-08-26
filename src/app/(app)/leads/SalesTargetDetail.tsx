"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { clsx } from "@/lib/clsx";

/**
 * The Sales Target panel's body, collapsed on a phone.
 *
 * Measured on a 393 x 852 screen: this panel is **1,101px tall** — taller than
 * the phone it is displayed on — and it sits above the leads. The first lead
 * therefore began at y=1305, a screen and a half down, so a page called "Sales
 * Target & Leads" showed no leads at all until you scrolled past a chart.
 *
 * On a phone it is now a single summary row that expands on tap. Nothing is
 * removed and nothing becomes unreachable; the panel simply stops standing
 * between the user and the list.
 *
 * ## Why there is no media query here
 *
 * The two states are expressed entirely in classes, which matters more than it
 * looks. `hidden sm:block` means the body is closed on a phone and open on a
 * desktop **from the very first paint** — the server and the client agree,
 * there is no hydration flash, and a desktop reader never depends on JavaScript
 * to see a panel that has always been visible there. The only thing state does
 * is open it on a phone.
 */
export function SalesTargetDetail({
  summary,
  children,
}: {
  summary: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="focus-ring -mx-1 flex w-[calc(100%+0.5rem)] items-center justify-between gap-3 rounded-xl px-1 py-2 text-left sm:hidden"
      >
        {summary}
        <ChevronDown
          className={clsx(
            "h-4 w-4 shrink-0 text-faint transition-transform",
            open && "rotate-180"
          )}
        />
      </button>

      {/* Closed on a phone until asked for; always open from `sm` up. */}
      <div className={clsx("sm:block", open ? "block" : "hidden")}>{children}</div>
    </>
  );
}
