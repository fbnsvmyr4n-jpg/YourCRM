"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search } from "lucide-react";
import { clsx } from "@/lib/clsx";
import { useAnchoredPosition } from "@/lib/use-anchored-position";
import { matchPeople } from "@/lib/person-search";

/** Someone the CRM already knows — a contact or a lead. */
export type Person = { name: string; company: string; email: string };

/**
 * Only the people you can actually reach.
 *
 * A lead captured from a phone call often has no email address, and offering
 * one as a suggestion where a message is being addressed produces something
 * that cannot be sent — the reader picks a name, the field fills with nothing,
 * and the failure arrives at submit with no explanation.
 *
 * Here rather than at each call site: the composer and the forward field both
 * address a message, and two copies of this filter is how one of them starts
 * suggesting people the other refuses to.
 */
export function addressablePeople(people: Person[]): Person[] {
  return people.filter((p) => p.email && p.email.includes("@"));
}

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
  recent = [],
  placeholder = "Contact name or company…",
  autoFocus,
  describe,
}: {
  value: string;
  onChange: (v: string) => void;
  onPick: (p: Person) => void;
  people: Person[];
  /**
   * Who to offer before anything has been typed, best first. Optional: a caller
   * with no real ordering to give passes nothing and the list stays closed
   * until the reader types, which is what this field always did.
   */
  recent?: Person[];
  placeholder?: string;
  autoFocus?: boolean;
  /** Second line of each suggestion. Defaults to the person's company. */
  describe?: (p: Person) => string;
}) {
  /**
   * Open from the start when this field takes focus on its own.
   *
   * `autoFocus` focuses the input during mount, which fires no focus event any
   * handler here can see — so the one case that matters most looked broken:
   * tapping New Email put the cursor in To with nothing offered, and the
   * suggestions only appeared if the reader tapped the field they were already
   * typing in. Measured with the recents working: list absent on open, present
   * after a blur and a real re-focus.
   */
  const [open, setOpen] = useState(Boolean(autoFocus));
  const [highlight, setHighlight] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);
  /* The list is portalled out of the field, so it is no longer inside `boxRef`
     — the click-away below has to be told about it separately or a click on a
     suggestion counts as a click outside, closes the list, unmounts the button
     and the pick never fires. */
  const listRef = useRef<HTMLUListElement | null>(null);
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  // A combobox has to name the list it controls, or a screen reader announces
  // the role without ever being able to reach the options.
  const listId = useId();

  const q = value.trim();
  /**
   * Before anything is typed, the people most recently written to.
   *
   * The field used to show nothing until the first keystroke, so finding
   * someone meant already knowing how they are spelled — the reader had to
   * supply the answer before the field would help them look for it. Most mail
   * goes to somebody recently corresponded with, and those are already known.
   *
   * Only when the caller has a real ordering to offer. An empty `recent` shows
   * nothing rather than the first few contacts a query happened to return,
   * which would be a "recent" list that was nothing of the kind.
   */
  const matches = q ? matchPeople(people, q) : recent.slice(0, 5);
  const showingRecent = !q && matches.length > 0;

  // Click-away, so the list can't be left stranded over whatever is below it.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const target = e.target as Node;
      const inField = boxRef.current?.contains(target);
      const inList = listRef.current?.contains(target);
      if (!inField && !inList) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  function choose(p: Person) {
    onPick(p);
    setOpen(false);
  }

  const secondary = describe ?? ((p: Person) => p.company);

  const listOpen = open && matches.length > 0;
  /* Matched to the field's own width and left-aligned with it, so it reads as
     the field's list rather than a menu that happens to be near it. */
  const pos = useAnchoredPosition(anchor, listOpen, { align: "start" });

  return (
    <div ref={boxRef} className="relative">
      <div ref={setAnchor} className="flex items-center gap-2 rounded-xl border border-[var(--border)] px-3 py-2.5">
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

      {/* Portalled to <body>. Written `absolute`, it was sliced off by the first
          ancestor with `overflow: hidden` — in the message reader that is the
          body it scrolls, and the list measured at 393x850 ran to y=1001 on an
          850px screen with two of its six rows reachable. There is no height
          this can be given that survives being inside a box shorter than it. */}
      {listOpen && pos && typeof document !== "undefined" &&
        createPortal(
          <ul
            ref={listRef}
            id={listId}
            className="popover fixed z-[61] overflow-y-auto overscroll-contain py-1"
            style={{ top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}
            role="listbox"
          >
          {/* Said out loud, because an unlabelled list of names appearing under
              an empty field reads as a search result for nothing typed. */}
          {showingRecent && (
            <li
              aria-hidden
              className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-faint"
            >
              Recent
            </li>
          )}
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
          </ul>,
          document.body
        )}
    </div>
  );
}
