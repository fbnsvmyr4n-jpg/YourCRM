"use client";

import { useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { clsx } from "@/lib/clsx";

/** How far the row slides to fully show the bin, and the point of no return. */
const REVEAL = 84;
const COMMIT = 44;

/**
 * Swipe a row left to uncover a delete button.
 *
 * The gesture people already have for a list of messages on a phone, where
 * there is no room for a control on every row and a long-press menu is a thing
 * you have to be told about.
 *
 * Touch only, deliberately. A mouse has hover and a pointer precise enough for
 * a small target, and the desktop list is not to change — `pointerdown` from a
 * mouse is ignored outright rather than styled around, so a click on a row is
 * exactly the click it was before this existed.
 *
 * The row moves under the finger rather than snapping open on a threshold: a
 * gesture that only reports its result at the end gives no way to tell whether
 * it was understood, and no way to change your mind halfway.
 */
export function SwipeToDelete({
  children,
  onDelete,
  label,
}: {
  children: React.ReactNode;
  onDelete: () => void;
  /** Named for a screen reader, which has no gesture to make. */
  label: string;
}) {
  const [dx, setDx] = useState(0);
  const [open, setOpen] = useState(false);
  /* State rather than the ref below, because the render reads it — the row is
     only animated while it is NOT being dragged, and a ref read during render
     is both a compiler error and a value React never re-renders for. */
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  /* Null until the direction is known. A row that grabbed the pointer on the
     first move would fight the list's own vertical scrolling, and the list
     scrolls far more often than a row is deleted. */
  const horizontal = useRef<boolean | null>(null);
  /* The same number as `dx`, kept synchronously.

     `onPointerUp` decides whether the swipe settles open, and reading `dx` for
     that reads the value from the last COMMITTED render. A quick flick — the
     last move and the release landing in one frame — releases with `dx` still
     0 and snaps shut, so the faster the gesture the less likely it was to
     work. Caught driving the swipe from a script, where every event lands in
     one tick and it failed every time. */
  const dxRef = useRef(0);

  function onPointerDown(e: React.PointerEvent) {
    if (e.pointerType === "mouse") return;
    /**
     * Capture, or the release can be delivered somewhere else.
     *
     * Without this, pointer events go to whatever is under the finger at the
     * time — and this row is MOVING under the finger, so `pointerup` can land
     * on a different element and never reach this handler. The drag then never
     * ends: `dragging` stays true, which keeps the bin on screen, while `open`
     * is never set. The row looks swiped and behaves as though it is not, so
     * the next tap opens the message instead of deleting it.
     *
     * Seen on an iPhone recording — the bin was showing and the tap opened the
     * message, with no confirmation in between.
     */
    e.currentTarget.setPointerCapture?.(e.pointerId);
    start.current = { x: e.clientX, y: e.clientY };
    horizontal.current = null;
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!start.current) return;
    const moveX = e.clientX - start.current.x;
    const moveY = e.clientY - start.current.y;

    if (horizontal.current === null) {
      /* 10px of travel before committing to a direction, and only if sideways
         movement is clearly winning. Below that a scroll that drifts a couple
         of pixels sideways would open a delete button under the thumb. */
      if (Math.abs(moveX) < 10 && Math.abs(moveY) < 10) return;
      horizontal.current = Math.abs(moveX) > Math.abs(moveY);
      if (horizontal.current) setDragging(true);
      else start.current = null;
      return;
    }

    /* Left only. Dragging right from a closed row does nothing rather than
       revealing a mirror-image control that does not exist. */
    const base = open ? -REVEAL : 0;
    const next = Math.max(-REVEAL, Math.min(0, base + moveX));
    dxRef.current = next;
    setDx(next);
  }

  function onPointerUp(e: React.PointerEvent) {
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (start.current && horizontal.current) {
      const settled = dxRef.current <= -COMMIT;
      setOpen(settled);
      dxRef.current = settled ? -REVEAL : 0;
      setDx(dxRef.current);
    }
    start.current = null;
    horizontal.current = null;
    setDragging(false);
  }

  function close() {
    setOpen(false);
    dxRef.current = 0;
    setDx(0);
  }

  const offset = dragging ? dx : open ? -REVEAL : 0;

  return (
    <div className="relative overflow-hidden rounded-2xl">
      {/* Behind the row, not beside it — so the row slides off it rather than
          the list reflowing around a control that appears.

          Only while the row is actually moving. Message rows have no background
          of their own, so a bin left mounted behind every row showed THROUGH
          all of them: the first swipe test put a red bin on every message in
          the list, including the ones nobody had touched.

          The whole revealed strip is the button, not a 44px target floating in
          it: a tap that lands in the red area but beside the icon should still
          delete, and anything else is a control that looks bigger than it is. */}
      {(dragging || open) && (
      <button
        type="button"
        aria-label={`Delete ${label}`}
        onClick={() => {
          close();
          onDelete();
        }}
        className="focus-ring absolute inset-y-0 right-0 grid w-[84px] place-items-center"
      >
        <span className="grid h-11 w-11 place-items-center rounded-xl bg-[var(--red)] text-white">
          <Trash2 className="h-5 w-5" />
        </span>
      </button>
      )}

      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        /* Vertical panning stays the browser's job; horizontal is ours. Without
           this the browser claims the gesture and the row never moves. */
        style={{ transform: `translateX(${offset}px)`, touchAction: "pan-y" }}
        className={clsx(
          /* `grid`, not `block`. The row it wraps is a <button>, which is
             inline-block and therefore sizes to its TEXT. As a direct child of
             the list's flex column it was stretched to full width for free;
             wrapping it took that away, and the bordered card came up short of
             the panel with a gap down its right-hand side. A grid parent
             stretches its child by default, and does it for whatever this
             wraps rather than relying on the caller to add `w-full`. */
          "relative grid",
          /* Animated only when settling. Following a finger has to be exact,
             and a transition during the drag is what makes a swipe feel like it
             is lagging behind the hand. */
          !dragging && "transition-transform duration-200 ease-out"
        )}
      >
        {/* A tap on the row puts it back rather than opening the message,
            whenever the bin is showing for ANY reason — settled open, or still
            mid-drag. Gating this on `open` alone is what let a stuck drag show
            a bin over a row that still opened the message when tapped. */}
        {(dragging || open) && (
          <button
            type="button"
            aria-label="Close delete"
            onClick={close}
            className="absolute inset-0 z-10 cursor-default"
          />
        )}
        {children}
      </div>
    </div>
  );
}
