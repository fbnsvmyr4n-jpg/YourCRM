"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Search } from "lucide-react";
import { clsx } from "@/lib/clsx";
import { useDropDirection } from "@/lib/use-anchored-position";
import { matchPeople } from "@/lib/person-search";
import { HighlightedMatch } from "@/components/ui/HighlightedMatch";

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

  /* Clamped rather than trusted. The list narrows as more is typed, and a
     highlight left pointing past the end would hand `undefined` to `choose`. */
  const active = Math.min(highlight, Math.max(0, matches.length - 1));

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

  /* The list has a max height and can scroll, so arrowing past its bottom edge
     would otherwise move a selection nobody can see. */
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  function choose(p: Person) {
    onPick(p);
    setOpen(false);
  }

  const secondary = describe ?? ((p: Person) => p.company);

  const listOpen = open && matches.length > 0;
  /* Matched to the field's own width and left-aligned with it, so it reads as
     the field's list rather than a menu that happens to be near it. */
  /* Direction only. The list is a child of the field, so where it sits is
     the browser's job — see the note on `useDropDirection`. */
  const { up, maxHeight } = useDropDirection(anchor, listOpen);

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
              choose(matches[active]);
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
      {/* A child of the field, placed by CSS. Positioning it in JavaScript
          against the viewport failed three times on a real iPhone — the list
          ended up as much as 118px from the box it belonged to — because every
          version re-derived a relationship the browser already keeps for free.
          `absolute` against the field cannot drift from it. */}
      {listOpen && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          className={clsx(
            "popover absolute left-0 right-0 z-[61] overflow-y-auto overscroll-contain py-0.5",
            up ? "bottom-full mb-1 popover-in-up" : "top-full mt-1 popover-in"
          )}
          style={{ maxHeight }}
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
                data-idx={i}
                onMouseEnter={() => setHighlight(i)}
                /* Keeps the caret in the field. Without it, pressing on a
                   suggestion blurs the input first: on iOS the keyboard
                   starts closing, the page reflows under the finger, and the
                   list moves out from under the tap that was aimed at it.
                   The pick still happens on click. */
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(p)}
                className={clsx(
                  "block w-full px-3 py-2 text-left text-sm transition-colors",
                  i === active && "bg-[var(--raise)]"
                )}
                role="option"
                aria-selected={i === active}
              >
                <span className="font-medium">
                  <HighlightedMatch text={p.name} query={value} />
                </span>
                {sub && sub !== "—" && (
                  <span className="ml-2 text-xs text-faint">
                    <HighlightedMatch text={sub} query={value} />
                  </span>
                )}
              </button>
            </li>
          );
        })}
        </ul>
      )}
    </div>
  );
}
