"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Search } from "lucide-react";
import { clsx } from "@/lib/clsx";

/** Someone the CRM already knows — a contact or a lead. */
export type Person = { name: string; company: string; email: string };

/**
 * Contact / company field with suggestions.
 *
 * Typing a name used to be pure recall — the CRM already knows everyone, so it
 * now offers them. Picking someone also hands back their company and email,
 * which is what makes meeting change-notifications, and addressing an email,
 * possible at all.
 *
 * Shared rather than copied: the meeting scheduler and the inbox composer both
 * need it, and this codebase has already paid once for having two of something
 * that should have been one (see the two 12-hour time parsers in the failure
 * log). Keyboard support and the combobox roles live here, so both callers get
 * them.
 */
export function PersonField({
  value,
  onChange,
  onPick,
  people,
  placeholder = "Contact name or company…",
  autoFocus,
  describe,
}: {
  value: string;
  onChange: (v: string) => void;
  onPick: (p: Person) => void;
  people: Person[];
  placeholder?: string;
  autoFocus?: boolean;
  /** Second line of each suggestion. Defaults to the person's company. */
  describe?: (p: Person) => string;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);
  // A combobox has to name the list it controls, or a screen reader announces
  // the role without ever being able to reach the options.
  const listId = useId();

  const q = value.trim().toLowerCase();
  const matches = q
    ? people
        .filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            p.company.toLowerCase().includes(q) ||
            p.email.toLowerCase().includes(q)
        )
        .slice(0, 6)
    : [];

  // Click-away, so the list can't be left stranded over whatever is below it.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  function choose(p: Person) {
    onPick(p);
    setOpen(false);
  }

  const secondary = describe ?? ((p: Person) => p.company);

  return (
    <div ref={boxRef} className="relative">
      <div className="flex items-center gap-2 rounded-xl border border-[var(--border)] px-3 py-2.5">
        <Search className="h-4 w-4 shrink-0 text-faint" />
        <input
          value={value}
          autoFocus={autoFocus}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
            setHighlight(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (!open || matches.length === 0) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlight((h) => (h + 1) % matches.length);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlight((h) => (h - 1 + matches.length) % matches.length);
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(matches[highlight]);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          placeholder={placeholder}
          className="field-bare"
          role="combobox"
          aria-expanded={open && matches.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
        />
      </div>

      {open && matches.length > 0 && (
        <ul
          id={listId}
          className="popover absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden py-1"
          role="listbox"
        >
          {matches.map((p, i) => {
            const sub = secondary(p);
            return (
              <li key={p.email || p.name}>
                <button
                  type="button"
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => choose(p)}
                  className={clsx(
                    "block w-full px-3 py-2 text-left text-sm transition-colors",
                    i === highlight && "bg-[var(--raise)]"
                  )}
                  role="option"
                  aria-selected={i === highlight}
                >
                  <span className="font-medium">{p.name}</span>
                  {sub && sub !== "—" && <span className="ml-2 text-xs text-faint">{sub}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
