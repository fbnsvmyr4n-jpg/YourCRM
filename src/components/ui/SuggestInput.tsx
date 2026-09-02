"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { clsx } from "@/lib/clsx";
import { matchStrings } from "@/lib/person-search";
import { HighlightedMatch } from "@/components/ui/HighlightedMatch";
import { useAnchoredPosition } from "@/lib/use-anchored-position";

/**
 * A text box that offers what has been typed into it before.
 *
 * The meeting form asked for a topic, a participant address and a meeting link
 * as three empty boxes, and all three are nearly always a repeat: a topic
 * recurs across a week of follow-ups, the link is usually the one standing
 * room, and the address belongs to somebody already on file. Retyping a
 * conferencing URL from memory is the worst of them — it is long, it is exact,
 * and getting it wrong produces a meeting nobody can join.
 *
 * Suggestions only, never a gate: anything can still be typed, and a value that
 * matches nothing is simply a new one. The list is built from what the account
 * has actually used, so an empty history offers nothing rather than examples
 * somebody might mistake for real records.
 *
 * Shares its positioning with the menus and the contact field, so it escapes
 * the same clipping cards and flips the same way when a phone keyboard leaves
 * no room beneath.
 */
export function SuggestInput({
  value,
  onChange,
  options,
  placeholder,
  type = "text",
  className,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  /** What this account has used before. Empty is fine — nothing is offered. */
  options: readonly string[];
  placeholder?: string;
  type?: "text" | "email" | "url";
  className?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);
  /* The list is portalled out, so the click-away has to be told about it or a
     press on a suggestion counts as a click outside: the list closes, the
     button unmounts, and the pick never lands. */
  const listRef = useRef<HTMLUListElement | null>(null);
  const [anchor, setAnchor] = useState<HTMLInputElement | null>(null);
  const listId = useId();

  const matches = matchStrings(options, value);
  const active = Math.min(highlight, Math.max(0, matches.length - 1));
  const listOpen = open && matches.length > 0;
  const pos = useAnchoredPosition(anchor, listOpen, { align: "start" });

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!boxRef.current?.contains(target) && !listRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  function choose(v: string) {
    onChange(v);
    setOpen(false);
  }

  return (
    <div ref={boxRef} className="relative">
      <input
        ref={setAnchor}
        value={value}
        type={type}
        aria-label={ariaLabel}
        placeholder={placeholder}
        className={clsx("field-input", className)}
        role="combobox"
        aria-expanded={listOpen}
        aria-controls={listId}
        aria-autocomplete="list"
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (!listOpen) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlight((h) => (h + 1) % matches.length);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((h) => (h - 1 + matches.length) % matches.length);
          } else if (e.key === "Enter") {
            /* Only when a suggestion is genuinely highlighted — Enter on a
               freshly typed value should submit what was typed, not silently
               swap it for the nearest match. */
            e.preventDefault();
            choose(matches[active]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />

      {listOpen &&
        pos &&
        typeof document !== "undefined" &&
        createPortal(
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            className={clsx(
              "popover fixed z-[61] overflow-y-auto overscroll-contain py-0.5",
              pos.bottom !== undefined ? "popover-in-up" : "popover-in"
            )}
            style={{
              top: pos.top,
              bottom: pos.bottom,
              left: pos.left,
              width: pos.width,
              maxHeight: pos.maxHeight,
            }}
          >
            {matches.map((m, i) => (
              <li key={m}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  data-idx={i}
                  onMouseEnter={() => setHighlight(i)}
                  /* Keeps the caret in the field: without it the press blurs
                     the input first, iOS starts closing the keyboard, and the
                     page reflows out from under the tap. */
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(m)}
                  className={clsx(
                    "block w-full truncate px-3 py-2 text-left text-sm transition-colors",
                    i === active && "bg-[var(--raise)]"
                  )}
                >
                  <HighlightedMatch text={m} query={value} />
                </button>
              </li>
            ))}
          </ul>,
          document.body
        )}
    </div>
  );
}
