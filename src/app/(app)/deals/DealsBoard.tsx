"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { edgeScrollStep, edgeScrollVelocity } from "@/lib/edge-scroll";
import { ArrowRightLeft, ChevronDown, Coins, Flame, GripVertical, HandCoins, Plus, Trash2, Wallet, X } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Overlay } from "@/components/ui/Overlay";
import { BOARD_STAGES as STAGES, carriesMoney } from "@/data/pipeline";
import type { Stage as StageId } from "@/server/repos/deals";
import type { Deal } from "@/server/decorate-deal";
export type { Deal } from "@/server/decorate-deal";

import { clsx } from "@/lib/clsx";
import {
  addDealAction,
  addPainPointsAction,
  deleteDealAction,
  moveDealAction,
  recordPaymentAction,
  recordReferralAction,
  removePainPointAction,
  setDealValueAction,
} from "./actions";

function money(n: number) {
  if (n >= 1000) {
    const k = n / 1000;
    return `$${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}K`;
  }
  return `$${n}`;
}
function fullMoney(n: number) {
  return `$${n.toLocaleString()}`;
}

/** A won record is only part of the story while it's short of the contract. */
const isPartiallyPaid = (d: Deal) =>
  isWon(d) && d.splitTotal !== undefined && d.value < d.splitTotal;

const PARTIAL = "#f97316"; // orange — money in, but not all of it

/**
 * Won-ness is a recorded fact, not a position on the board.
 *
 * `won_at` survives the deal moving on to Delivery and Referral, which are
 * post-close stages. Reading the stage instead would make revenue fall the
 * moment work began — success looking like a loss.
 */
const isWon = (d: Deal) => d.wonAt !== null;

export function DealsBoard({ deals }: { deals: Deal[] }) {
  const [items, setItems] = useState<Deal[]>(deals);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<StageId | null>(null);
  /*
     Stages the reader has folded away, on a phone.

     The board is a vertical stack below `sm`, so at 375px it ran to 3,428px —
     4.2 screens for fifteen deals, with Discovery alone 1,388px and Closed Won
     968px. Reaching Delivery meant scrolling past every won deal of the year.

     A set of what is CLOSED rather than a map of what is open: a stage nobody
     has touched is open, which keeps the default correct without seeding state
     for stages that may not exist on another account's board.

     Desktop never reads this. Each stage body carries an unconditional
     `sm:flex`, so from `sm` up the columns are laid out whatever this holds.
  */
  const [folded, setFolded] = useState<Set<StageId>>(new Set());
  /** The deal whose stage the phone is choosing. Never set above `sm`. */
  const [moving, setMoving] = useState<Deal | null>(null);

  /*
     Scrolling the board while a card is being dragged over its edge.

     The board is wider than the window from `sm` up, and dragging a card
     toward a stage that is off screen did nothing — the card stopped at the
     edge, so reaching a later stage meant dropping it somewhere it did not
     belong, scrolling, and picking it up again.

     A rAF loop rather than scrolling from `dragover` itself: `dragover` only
     fires while the pointer MOVES, so a card held still against the edge —
     which is exactly what someone does when waiting for the board to come to
     them — would stop scrolling until they jiggled it.

     Inert on a phone by construction. Below `sm` the stages are a vertical
     stack with nothing to scroll horizontally, and touch never fires a drag at
     all.
  */
  const boardRef = useRef<HTMLDivElement | null>(null);
  const velocity = useRef(0);
  const frame = useRef<number | null>(null);

  const stopEdgeScroll = useCallback(() => {
    velocity.current = 0;
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
  }, []);

  /* Scaled by real elapsed time, not assumed to be 60fps. Measured on a 120Hz
     display the unscaled loop moved 399px where 60Hz moved 198 — the board was
     literally twice as fast on better hardware. */
  const lastAt = useRef(0);
  const step = useCallback((now: number) => {
    const el = boardRef.current;
    if (!el || velocity.current === 0) {
      frame.current = null;
      return;
    }
    const elapsed = lastAt.current === 0 ? 0 : now - lastAt.current;
    lastAt.current = now;
    el.scrollLeft += edgeScrollStep(velocity.current, elapsed);
    frame.current = requestAnimationFrame(step);
  }, []);

  const edgeScroll = useCallback(
    (clientX: number) => {
      const el = boardRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      velocity.current = edgeScrollVelocity(clientX, { left: r.left, right: r.right });
      if (velocity.current !== 0 && frame.current === null) {
        lastAt.current = 0;
        frame.current = requestAnimationFrame(step);
      }
    },
    [step]
  );

  /* A drag that ends while the board is still moving would leave the loop
     running against a card nobody is holding. */
  useEffect(() => stopEdgeScroll, [stopEdgeScroll]);
  const [addOpen, setAddOpen] = useState<StageId | true | null>(null);
  const [active, setActive] = useState<Deal | null>(null);
  const [busy, setBusy] = useState(false);
  // A refused move, said out loud. Silently snapping the card back would look
  // like the drag failed to register rather than like the server said no.
  const [moveError, setMoveError] = useState<string | null>(null);

  /**
   * Header totals, each defined by a stage's own exit condition.
   *
   * These were named for a pipeline that no longer exists. "Negotiations Owed —
   * invoiced, awaiting payment" was summing the DISCOVERY column: nobody has
   * invoiced a deal they are still qualifying, so the tile reported money owed
   * that had never been asked for. The label was stale; the number was false.
   *
   * The definitions now follow the process:
   *
   *   Open pipeline  Discovery + Demo. Live work, not yet won.
   *   In delivery    The Delivery column — won, and being delivered. Post-close
   *                  work is where the referrals come from, so it is worth its
   *                  own number rather than being folded into the won total.
   *   Won            Read from the recorded fact, not the column, so it
   *                  survives Delivery and Referral rather than falling the
   *                  moment delivery begins. Matches what Reports calls
   *                  revenue.
   *
   * Prospect carries no money on purpose: a prospect nobody has spoken to has
   * no value worth adding up, and inventing one puts imaginary money in the
   * total.
   */
  const summary = useMemo(() => {
    const sum = (stage: StageId) =>
      items.filter((d) => d.stage === stage).reduce((s, d) => s + d.value, 0);
    return {
      open: sum("discovery") + sum("demo"),
      inDelivery: sum("delivery"),
      // Won is read from the recorded fact, so it survives Delivery and
      // Referral rather than falling the moment delivery begins.
      won: items.filter(isWon).reduce((s, d) => s + d.value, 0),
      count: items.length,
    };
  }, [items]);

  async function handleDrop(stage: StageId) {
    setOverStage(null);
    const id = dragId;
    setDragId(null);
    if (!id) return;
    await moveDeal(id, stage);
  }

  /**
   * The one path a deal changes stage by.
   *
   * Dragging and the phone's Move sheet both land here rather than each doing
   * their own optimistic update. The interesting parts below — the split merge,
   * the whole-board snapshot, the rollback on a refusal — are exactly the parts
   * a second copy would get subtly wrong, and the two would then disagree only
   * in the cases nobody tests by hand.
   */
  async function moveDeal(id: string, stage: StageId) {
    const current = items.find((d) => d.id === id);
    if (!current || current.stage === stage) return;

    // The whole board before the move, so a refusal can be undone exactly. A
    // per-card revert cannot express the split merge below, which removes one
    // card and changes the value of another.
    const before = items;

    // Settling the remainder merges it into the record holding the part already
    // paid. Mirrored here so the board doesn't briefly show two cards before
    // the server response lands.
    const sibling =
      stage === "won" && current.splitId
        ? items.find((d) => d.id !== id && d.splitId === current.splitId && isWon(d))
        : undefined;

    setItems((prev) =>
      sibling
        ? prev
            .filter((d) => d.id !== id)
            .map((d) => (d.id === sibling.id ? { ...d, value: d.value + current.value } : d))
        : prev.map((d) =>
            d.id === id ? { ...d, stage, value: carriesMoney(stage) ? d.value : 0 } : d
          )
    );

    /**
     * The result was thrown away, and the action can refuse — from this board,
     * by the deal having been deleted somewhere else in the meantime. The card
     * stayed in its new column regardless, and the totals across the top are
     * summed from these same cards, so a refused move quietly shifted money
     * between "Open pipeline" and "Closed won" on screen and nowhere else.
     */
    const result = await moveDealAction(id, stage);
    if (result?.error) {
      setItems(before);
      setMoveError(result.error);
    }
  }

  async function handleAdd(formData: FormData) {
    setBusy(true);
    try {
      // The action returns an id, not a card: the board shows a contact's name
      // and initials, which live on the contact record rather than the deal
      // now that the link is a foreign key. Inserting a half-built card here
      // would flash a nameless row until the refresh replaced it, so the
      // revalidation the action triggers is what puts the deal on the board.
      await addDealAction(formData);
      setAddOpen(null);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Deleting a deal was one click with no confirmation and no check that it
   * worked: the card was removed locally and the action fired without being
   * awaited. A mis-click destroyed a deal instantly, and a failure destroyed
   * only the card while the deal stayed in the database.
   *
   * The card still leaves immediately — waiting on a round trip to acknowledge
   * a drag-and-drop board is worse — but the removal is now undone if the
   * server says the deal is still there.
   */
  function toggleFold(id: StageId) {
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleDelete(id: string) {
    const deal = items.find((d) => d.id === id);
    if (!deal) return;
    if (
      !confirm(
        `Delete "${deal.title}"? You can put it back from Settings → Recently deleted.`
      )
    )
      return;

    setItems((prev) => prev.filter((d) => d.id !== id));
    const gone = await deleteDealAction(id);
    // Put it back exactly where it was rather than leaving the board claiming
    // something happened that did not.
    if (!gone) setItems((prev) => (prev.some((d) => d.id === id) ? prev : [...prev, deal]));
  }

  async function handlePayment(deal: Deal, formData: FormData) {
    setBusy(true);
    try {
      const res = await recordPaymentAction(deal.id, formData);
      if (res?.error) return res.error;

      const paid = Number(formData.get("amount"));
      const remaining = deal.value - paid;
      const splitId = deal.splitId ?? `local-${deal.id}`;
      const splitTotal = deal.splitTotal ?? deal.value;

      setItems((prev) => {
        const existingWon = prev.find((d) => d.splitId === splitId && isWon(d));

        let next = prev.map((d) =>
          d.id === deal.id ? { ...d, value: remaining, splitId, splitTotal } : d
        );

        if (existingWon) {
          next = next.map((d) => (d.id === existingWon.id ? { ...d, value: d.value + paid } : d));
        } else {
          next = [
            {
              ...deal,
              id: `${deal.id}-paid-local`,
              value: paid,
              stage: "won" as StageId,
              splitId,
              splitTotal,
              wonAt: new Date().toISOString(),
            },
            ...next,
          ];
        }

        return remaining === 0 ? next.filter((d) => d.id !== deal.id) : next;
      });

      setActive(null);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function handleSetValue(deal: Deal, formData: FormData) {
    setBusy(true);
    try {
      await setDealValueAction(deal.id, formData);
      const value = Math.max(0, Math.round(Number(formData.get("value")) || 0));
      setItems((prev) => prev.map((d) => (d.id === deal.id ? { ...d, value } : d)));
      setActive(null);
    } finally {
      setBusy(false);
    }
  }

  const defaultStage = addOpen && addOpen !== true ? addOpen : "prospect";

  return (
    /* The fixed viewport height belongs to the side-by-side board. Once the
       stages stack it would trap the whole pipeline inside one screen-height
       box with its own scrollbar, so below `sm` the height is left to the
       content and the page scrolls normally. */
    <div className="mx-auto flex max-w-[1600px] animate-fade-up flex-col sm:h-[calc(100vh-104px)]">
      <div className="flex flex-wrap items-start justify-between gap-4 pb-4 pt-1">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Deals Pipeline</h1>
          <p className="mt-1 text-sm text-muted">
            Drag deals across stages. Each column says what has to happen for a
            card to leave it.
          </p>
        </div>
      </div>

      {moveError ? (
        <div
          role="alert"
          className="mb-4 flex items-center justify-between gap-3 rounded-xl px-4 py-3 text-sm"
          style={{ background: "var(--red-soft)", color: "var(--red)" }}
        >
          <span>{moveError}</span>
          <button
            type="button"
            onClick={() => setMoveError(null)}
            className="focus-ring rounded-lg px-2 py-1 text-xs font-semibold"
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {/*
          Ranked, not tiled.

          Four equal boxes said these are four equal facts, and they are not.
          Three are money and one is a count; and among the money, only Open
          Pipeline is about what can still happen. Closed Won is the scoreboard,
          In Delivery is a sub-state of it, and Total Deals is context for all
          three.

          So the grid gives Open Pipeline the full width, pairs the two "won"
          figures beneath it, and lays the count out as a slim strip at the
          bottom, where a number that is not money stops competing with the
          ones that are.

          The pair reads left to right in the order the money actually moves:
          In Delivery is won but not yet delivered, Closed Won is the banked
          total it ends up in. Ordering them by size instead was the first
          attempt and it put the destination before the step that reaches it.

          Three across was the other candidate and it fails on measurement, not
          taste: at 375px it leaves each card about 86px of text column and
          "$379,800" needs 94, so it would bring back the truncation this page
          was just fixed for.

          Every span is `@min-[880px]:col-span-1`, so the desktop row of four
          is exactly what it was.
      */}
      <div className="mb-4 grid grid-cols-2 gap-3 @min-[880px]:grid-cols-4">
        <SummaryTile
          className="col-span-2 @min-[880px]:col-span-1"
          wide
          icon={<Wallet className="h-5 w-5" />}
          label="Open Pipeline"
          sub="Discovery and Demo"
          value={fullMoney(summary.open)}
          tone="var(--amber)"
          soft="var(--amber-soft)"
        />
        <SummaryTile
          icon={<HandCoins className="h-5 w-5" />}
          label="In Delivery"
          sub="Won, being delivered"
          value={fullMoney(summary.inDelivery)}
          tone={PARTIAL}
          soft="rgba(249,115,22,0.12)"
        />
        <SummaryTile
          icon={<Coins className="h-5 w-5" />}
          label="Closed Won"
          sub="Won, all time"
          value={fullMoney(summary.won)}
          tone="var(--green)"
          soft="var(--green-soft)"
        />
        <SummaryTile
          className="col-span-2 @min-[880px]:col-span-1"
          wide
          icon={<GripVertical className="h-5 w-5" />}
          label="Total Deals"
          sub="Across all stages"
          value={String(summary.count)}
          tone="var(--accent)"
          soft="var(--accent-soft)"
        />
      </div>

      {/*
          The section heading the board never had, and where Add Deal belongs.

          The button sat under the page description, floating above four
          summary tiles that have nothing to do with adding anything — you
          reached for it before you had seen the board it acts on. Here it sits
          on the row that names the thing it adds to, which is the pattern the
          Leads page already uses.
      */}
      <div className="mb-3 flex items-center justify-between gap-3">
        {/* No count beside the heading. "Total Deals 15" is the tile directly
            above it, and every stage header below carries its own — a third
            copy in between would be the Lead Sources mistake again. */}
        <h2 className="text-lg font-semibold tracking-tight">Pipeline</h2>
        <button
          onClick={() => setAddOpen(true)}
          className="btn-accent focus-ring flex shrink-0 items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold"
        >
          <Plus className="h-[16px] w-[16px]" /> Add Deal
        </button>
      </div>

      {/*
          Stacked on a phone, side by side from `sm`.

          A kanban is a horizontal idea, and on a 393px screen that meant one
          stage visible and the rest off the edge behind a scrollbar — the user
          could not see their own pipeline without dragging sideways, and had no
          way of knowing how many stages there were. Stacking turns it into a
          list of stages, each full width, which is what every mobile board app
          does for the same reason.

          Dragging is a desktop-only affordance and always was, though this
          comment used to claim otherwise. iOS Safari does not fire the HTML5
          drag events for touch at all — there is no `dragstart` from a finger —
          so on a phone the board looked interactive and simply was not. Every
          card carries a Move control below `sm` instead; see `MoveSheet`.
      */}
      <div
        ref={boardRef}
        /* Bubbles up from the stage columns, so this sees every dragover on the
           board without each column having to forward one. */
        onDragOver={(e) => edgeScroll(e.clientX)}
        onDragLeave={(e) => {
          /* Only when the pointer has actually left the board, not when it
             crosses between two columns inside it. */
          if (!e.currentTarget.contains(e.relatedTarget as Node)) stopEdgeScroll();
        }}
        onDrop={stopEdgeScroll}
        className="-mx-1 flex flex-col gap-4 px-1 pb-2 sm:flex-1 sm:scroll-p-2 sm:flex-row sm:overflow-x-auto"
      >
        {STAGES.map((stage) => {
          const stageDeals = items.filter((d) => d.stage === stage.id);
          const total = stageDeals.reduce((s, d) => s + d.value, 0);
          const isOver = overStage === stage.id;
          const isFolded = folded.has(stage.id);
          const showsMoney = carriesMoney(stage.id);

          return (
            <div
              key={stage.id}
              onDragOver={(e) => {
                e.preventDefault();
                if (overStage !== stage.id) setOverStage(stage.id);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverStage(null);
              }}
              onDrop={() => handleDrop(stage.id)}
              className={clsx(
                "flex w-full flex-col rounded-2xl border transition-colors sm:w-[300px] sm:shrink-0",
                isOver ? "border-[var(--border-strong)] bg-[var(--raise)]" : "border-[var(--border)]"
              )}
            >
              {/* The divider separates the header from a body. Folded, there is
                  no body, and the rule was left hanging under the last line of
                  text like a mis-drawn card. */}
              <div
                className={clsx(
                  "px-4 py-3",
                  isFolded ? "border-b-0 sm:border-b" : "border-b",
                  "border-[var(--border)]"
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  {/* The header is the fold control, and only on a phone.
                      `sm:pointer-events-none` leaves the desktop column header
                      exactly the inert label it has always been rather than a
                      button that appears to do nothing. */}
                  <button
                    type="button"
                    onClick={() => toggleFold(stage.id)}
                    aria-expanded={!isFolded}
                    aria-controls={`stage-${stage.id}`}
                    className="focus-ring -m-1 flex min-w-0 items-center gap-2 rounded-lg p-1 text-left sm:pointer-events-none"
                  >
                    <ChevronDown
                      className={clsx(
                        "h-4 w-4 shrink-0 text-faint transition-transform sm:hidden",
                        !isFolded && "rotate-180"
                      )}
                    />
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: stage.color }} />
                    <span className="truncate text-sm font-semibold">{stage.label}</span>
                    <span
                      className="shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-semibold text-muted"
                      style={{ background: "var(--raise)" }}
                    >
                      {stageDeals.length}
                    </span>
                  </button>
                  {/* No total on the stages that carry no money — a sum of
                      zeroes still reads as "this column is worth nothing". */}
                  {showsMoney && (
                    <span className="text-xs font-semibold" style={{ color: stage.color }}>
                      {money(total)}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-[11px] text-faint">{stage.exit}</p>
              </div>

              {/* `sm:flex` is unconditional: from `sm` up the body is laid out
                  whatever the fold state says, so a desktop reader never depends
                  on client state to see a column that was always open there. */}
              <div
                id={`stage-${stage.id}`}
                className={clsx(
                  "flex-1 flex-col gap-2.5 overflow-y-auto p-3 sm:flex",
                  isFolded ? "hidden" : "flex"
                )}
              >
                {stageDeals.map((deal) => (
                  <DealCard
                    key={deal.id}
                    deal={deal}
                    dragging={dragId === deal.id}
                    onDragStart={() => setDragId(deal.id)}
                    onDragEnd={() => {
                      setDragId(null);
                      setOverStage(null);
                      stopEdgeScroll();
                    }}
                    onOpen={() => setActive(deal)}
                    onMove={() => setMoving(deal)}
                    onDelete={() => handleDelete(deal.id)}
                  />
                ))}
                <button
                  onClick={() => setAddOpen(stage.id)}
                  className="focus-ring flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-[var(--border)] py-2 text-xs font-medium text-faint transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text)]"
                >
                  <Plus className="h-3.5 w-3.5" /> Add deal
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {addOpen !== null && (
        <AddDealModal busy={busy} defaultStage={defaultStage} onClose={() => setAddOpen(null)} onSubmit={handleAdd} />
      )}

      {moving && (
        /* Looked up live rather than used from the snapshot taken when Move was
           tapped, so the sheet cannot go on offering a stage the deal has
           already left. Same reason the detail panel below does it. */
        <MoveSheet
          deal={items.find((d) => d.id === moving.id) ?? moving}
          onClose={() => setMoving(null)}
          onPick={async (stage) => {
            const id = moving.id;
            setMoving(null);
            await moveDeal(id, stage);
          }}
        />
      )}

      {active && (
        /**
         * Rendered from the LIVE item, not from the snapshot taken when the
         * card was clicked.
         *
         * Capturing a pain point saved it and the open panel went on saying
         * "Nothing was captured in Discovery" — so the obvious next move is to
         * type it again, and now it is in there twice. Looking the deal up by
         * id on every render means anything that changes it shows immediately.
         */
        <DealModal
          deal={items.find((d) => d.id === active.id) ?? active}
          busy={busy}
          onClose={() => setActive(null)}
          onPay={(fd) => handlePayment(active, fd)}
          onSetValue={(fd) => handleSetValue(active, fd)}
          onPainPoints={(painPoints) =>
            setItems((prev) =>
              prev.map((d) => (d.id === active.id ? { ...d, painPoints } : d))
            )
          }
        />
      )}
    </div>
  );
}

function SummaryTile({
  icon,
  label,
  sub,
  value,
  tone,
  soft,
  wide,
  className,
}: {
  icon: React.ReactNode;
  label: string;
  sub: string;
  value: string;
  tone: string;
  soft: string;
  /** Spans the full width on a phone, so it keeps the icon beside the figure. */
  wide?: boolean;
  className?: string;
}) {
  return (
    /*
       Stacked on a phone, side by side from `sm`.

       As a row at 375px the card is 155px wide; the padding takes 32 and the
       icon and its gap take another 56, leaving 67px of text column for a
       figure that needs 94. Every money value on this page rendered as
       "$286,..." — and a truncated currency figure is not a smaller version of
       the number, it is a different number. "Won, being delivered" and "Across
       all stages" were cut the same way.

       Stacking gives the value the full width of the card, which is the entire
       reason the card exists. From `sm` the row returns untouched.
    */
    <div
      className={clsx(
        "card flex p-4",
        /* Stacking exists to buy width for the figure. A tile that already
           spans the row has the width, so it keeps the icon beside the number
           and stays short — which is what makes the wide ones read as a
           different rank from the pair between them. */
        wide
          ? "flex-row items-center gap-3"
          : "flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3",
        className
      )}
    >
      <span
        className={clsx(
          "grid shrink-0 place-items-center rounded-xl sm:h-11 sm:w-11",
          wide ? "h-11 w-11" : "h-9 w-9"
        )}
        style={{ background: soft, color: tone }}
      >
        {icon}
      </span>
      <div className="w-full min-w-0 leading-tight">
        <p className="truncate text-xl font-bold tabular-nums">{value}</p>
        <p className="truncate text-[11px] font-medium">{label}</p>
        <p className="truncate text-[10px] text-faint">{sub}</p>
      </div>
    </div>
  );
}

/**
 * Choosing a stage, for the devices that cannot drag.
 *
 * iOS Safari does not fire the HTML5 drag events for touch — there is no
 * `dragstart` from a finger — so the board was interactive-looking and inert on
 * every iPhone. Two ways to fix that: reimplement dragging on pointer events,
 * or give the phone a control that says what dragging says.
 *
 * This is the second, and it is the better fit for THIS board rather than
 * merely the cheaper one. Below `sm` the stages are a vertical stack, so
 * dragging a card from Discovery to Delivery means holding a finger down while
 * the page auto-scrolls past nine cards — a gesture that also has to be
 * disambiguated from the scroll it is fighting. A picker is two taps, needs no
 * long-press, and is reachable by a screen reader, which a custom drag is not.
 *
 * Desktop never sees it: the control that opens it is `sm:hidden` and dragging
 * there is untouched.
 */
function MoveSheet({
  deal,
  onClose,
  onPick,
}: {
  deal: Deal;
  onClose: () => void;
  onPick: (stage: StageId) => void;
}) {
  return (
    <Overlay>
      <div className="fixed inset-0 z-50 grid place-items-end p-3 sm:place-items-center" role="dialog" aria-modal="true">
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
        <div className="modal-surface relative z-10 w-full max-w-md p-5">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold tracking-tight">Move deal</h2>
              <p className="truncate text-xs text-faint">
                {deal.title} · {deal.contact}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 text-faint hover:text-[var(--text)]"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="flex flex-col gap-1.5">
            {STAGES.map((stage) => {
              const here = deal.stage === stage.id;
              return (
                <button
                  key={stage.id}
                  type="button"
                  onClick={() => (here ? onClose() : onPick(stage.id))}
                  aria-current={here ? "true" : undefined}
                  className={clsx(
                    "focus-ring flex w-full items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors",
                    here
                      ? "border-[var(--border-strong)] bg-[var(--raise)]"
                      : "border-[var(--border)] hover:border-[var(--border-strong)]"
                  )}
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: stage.color }}
                  />
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className="block text-sm font-semibold">{stage.label}</span>
                    {/* The same exit criterion the column header carries, so
                        the choice is made against the rule rather than the
                        name. */}
                    <span className="mt-0.5 block truncate text-[11px] text-faint">{stage.exit}</span>
                  </span>
                  {here && (
                    <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-faint">
                      Current
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </Overlay>
  );
}

function DealCard({
  deal,
  dragging,
  onDragStart,
  onDragEnd,
  onOpen,
  onMove,
  onDelete,
}: {
  deal: Deal;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onOpen: () => void;
  onMove: () => void;
  onDelete: () => void;
}) {
  const showsMoney = carriesMoney(deal.stage);
  const partial = isPartiallyPaid(deal);
  const needsValue = showsMoney && deal.value === 0;

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", deal.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      className={clsx(
        "group cursor-grab rounded-xl border bg-[var(--panel-solid)] p-3 transition-all active:cursor-grabbing",
        partial ? "border-[color:var(--partial)]" : "border-[var(--border)] hover:border-[var(--border-strong)]",
        dragging && "opacity-40"
      )}
      style={{ boxShadow: "0 1px 2px rgba(0,0,0,0.04)", ...({ "--partial": PARTIAL } as React.CSSProperties) }}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-sm font-semibold leading-snug">{deal.title}</p>
        {/*
            The phone's replacement for dragging.

            `sm:hidden`, so the desktop card is untouched and keeps the drag it
            already has. `stopPropagation` because the card itself opens the
            detail sheet on click.
        */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onMove();
          }}
          aria-label={`Move "${deal.title}" to another stage`}
          className="btn-soft focus-ring -my-1 flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold text-muted sm:hidden"
        >
          <ArrowRightLeft className="h-3 w-3" /> Move
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          /*
             Revealed on hover, on focus, and unconditionally where there is no
             hover to reveal it with.

             `opacity-0 group-hover:opacity-100` makes a control that a phone
             can never show: touch has no hover state, so this button was
             invisible AND unreachable on every mobile device — deleting a deal
             simply could not be done there. `max-sm:opacity-100` restores it
             below `sm` and changes nothing above it.

             Safe to surface: the action confirms first and is recoverable from
             Settings → Recently deleted, so a mis-tap costs a dialog rather
             than a record.
          */
          className="focus-ring shrink-0 rounded text-faint opacity-0 transition-opacity hover:text-[var(--red)] focus-visible:opacity-100 group-hover:opacity-100 max-sm:opacity-100"
          aria-label="Delete deal"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mt-2.5 flex items-center gap-2">
        <Avatar initials={deal.initials} color={deal.color} size="sm" />
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-xs font-medium">{deal.contact}</p>
          <p className="truncate text-[11px] text-faint">{deal.company}</p>
        </div>
      </div>

      {/**
        * What the prospect said hurts, at a glance.
        *
        * A card in Demo with nothing captured is the one worth seeing from
        * across the board: it means Discovery did not really happen, and the
        * call is about to be a feature tour. Counting them is the cheap half;
        * flagging the absence is the half that changes what somebody does.
        */}
      {(deal.painPoints?.length ?? 0) > 0 ? (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-faint">
          <Flame className="h-3 w-3" />
          {deal.painPoints.length === 1 ? "1 pain point" : `${deal.painPoints.length} pain points`}
        </p>
      ) : deal.stage === "demo" ? (
        <p className="mt-2 flex items-center gap-1.5 text-[11px]" style={{ color: "var(--amber)" }}>
          <Flame className="h-3 w-3" />
          No pain captured
        </p>
      ) : null}

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-[var(--border)] pt-2.5">
        {showsMoney ? (
          needsValue ? (
            // Arrived from Prospect, which carries no figure. Say what's
            // missing rather than printing a $0 that looks like a valuation.
            <span className="text-xs font-medium text-accent">Set value →</span>
          ) : (
            <span
              className="text-sm font-bold"
              style={{ color: partial ? PARTIAL : isWon(deal) ? "var(--green)" : "var(--text)" }}
            >
              {money(deal.value)}
            </span>
          )
        ) : (
          <span className="text-[11px] text-faint">No value yet</span>
        )}

        {partial ? (
          <span
            className="rounded-full px-2 py-0.5 text-[10px] font-bold"
            style={{ background: "rgba(249,115,22,0.14)", color: PARTIAL }}
          >
            PART PAID
          </span>
        ) : (
          <span className="text-[11px] text-faint">{deal.closeDate}</span>
        )}
      </div>

      {partial && deal.splitTotal && (
        <p className="mt-1.5 text-[10px] text-faint">
          {fullMoney(deal.value)} of {fullMoney(deal.splitTotal)} received
        </p>
      )}
    </div>
  );
}

/* ---------------- Deal detail: payment / value ---------------- */

function DealModal({
  deal,
  busy,
  onClose,
  onPay,
  onSetValue,
  onPainPoints,
}: {
  deal: Deal;
  busy: boolean;
  onClose: () => void;
  onPay: (formData: FormData) => Promise<string | null>;
  onSetValue: (formData: FormData) => void | Promise<void>;
  onPainPoints: (points: string[]) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  // Payment is recorded against a deal that has been presented — Discovery or
  // Demo. Recording one is what CLOSES it: the won record is created and
  // `won_at` stamped, so a deal already in Won has nothing left to pay.
  const canPay = (deal.stage === "demo" || deal.stage === "discovery") && deal.value > 0;
  const canValue = carriesMoney(deal.stage) && !isWon(deal);

  return (
    <Overlay>
      <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true">
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
        <div className="modal-surface relative z-10 w-full max-w-md p-6">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold tracking-tight">{deal.title}</h2>
              <p className="truncate text-xs text-faint">
                {deal.contact} · {deal.company}
              </p>
            </div>
            <button type="button" onClick={onClose} className="shrink-0 text-faint hover:text-[var(--text)]" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>

          <PainPoints deal={deal} busy={busy} onChange={onPainPoints} />

          <AskForReferral deal={deal} busy={busy} />

          {isPartiallyPaid(deal) && deal.splitTotal && (
            <div className="mb-4 rounded-xl p-3" style={{ background: "rgba(249,115,22,0.10)" }}>
              <p className="text-sm font-semibold" style={{ color: PARTIAL }}>
                Partly paid — {fullMoney(deal.value)} of {fullMoney(deal.splitTotal)}
              </p>
              <p className="mt-0.5 text-xs text-muted">
                {`${fullMoney(deal.splitTotal - deal.value)} is still outstanding. Drag it here when it lands and the two merge back into one deal.`}
              </p>
            </div>
          )}

          {canPay && (
            <form
              action={async (formData: FormData) => {
                setError(null);
                const err = await onPay(formData);
                if (err) setError(err);
              }}
              className="rounded-xl border border-[var(--border)] p-4"
            >
              <p className="text-sm font-semibold">Record a payment</p>
              {/* One expression rather than `{value} outstanding` — JSX drops the
                  space between an expression and adjacent text here, which
                  rendered as "$24,000outstanding". */}
              <p className="mt-0.5 text-xs text-muted">
                {`${fullMoney(deal.value)} outstanding. What's received moves to Closed Won; the rest stays here.`}
              </p>

              <label className="mt-3 block">
                <span className="mb-1.5 block text-xs font-medium text-muted">Amount received ($)</span>
                <input
                  name="amount"
                  type="number"
                  min={1}
                  max={deal.value}
                  required
                  autoFocus
                  placeholder={String(deal.value)}
                  className="field-input"
                />
              </label>

              {error && <p className="mt-2 text-xs" style={{ color: "var(--red)" }}>{error}</p>}

              <div className="mt-3 flex justify-end gap-2">
                <button
                  type="submit"
                  disabled={busy}
                  className="btn-accent focus-ring rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-60"
                >
                  {busy ? "Recording…" : "Record payment"}
                </button>
              </div>
            </form>
          )}

          {canValue && (
            <form action={onSetValue} className={clsx("rounded-xl border border-[var(--border)] p-4", canPay && "mt-3")}>
              <p className="text-sm font-semibold">{deal.value === 0 ? "Set deal value" : "Update deal value"}</p>
              <p className="mt-0.5 text-xs text-muted">
                The quoted amount for this deal.
              </p>
              <label className="mt-3 block">
                <span className="mb-1.5 block text-xs font-medium text-muted">Value ($)</span>
                <input
                  name="value"
                  type="number"
                  min={0}
                  required
                  autoFocus={!canPay}
                  defaultValue={deal.value || undefined}
                  placeholder="10000"
                  className="field-input"
                />
              </label>
              <div className="mt-3 flex justify-end">
                <button
                  type="submit"
                  disabled={busy}
                  className="btn-soft focus-ring rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-60"
                >
                  Save value
                </button>
              </div>
            </form>
          )}

          {!canPay && !canValue && (
            /**
             * Every post-close stage, not just Won.
             *
             * This branch tested `stage === "won"` and sent everything else to
             * "deals in this stage don't carry a value yet" — so a delivered
             * deal worth $12,000 was told it had no value. Delivery and
             * Referral are won stages; they came after this message was
             * written and inherited the wrong half of it.
             */
            <p className="rounded-xl border border-[var(--border)] p-4 text-sm text-muted">
              {deal.stage === "won"
                ? "This deal is settled in full."
                : deal.stage === "delivery"
                  ? "Won and being delivered. This is where the referral comes from."
                  : deal.stage === "referral"
                    ? "Won, delivered, and asked. Anyone they name starts again at Prospect."
                    : "Deals in this stage don't carry a value yet — move it to Discovery once there's a number to put on it."}
            </p>
          )}
        </div>
      </div>
    </Overlay>
  );
}

/**
 * Pain points — captured in Discovery, and what the Demo is built from.
 *
 * The mechanic at the centre of the process, and the thing a generic CRM does
 * not do. Discovery exists to find out what actually hurts; the Demo exists to
 * show that those specific things stop hurting. Without this the demo is a
 * feature tour, which is the presentation everybody gives and nobody
 * remembers.
 *
 * So the same record reads differently by stage: in Discovery it asks, in Demo
 * it tells you what to build the presentation around — and says so loudly when
 * there is nothing there, because a Demo with no captured pain means Discovery
 * did not happen and the call is about to be a feature tour.
 */
function PainPoints({
  deal,
  busy,
  onChange,
}: {
  deal: Deal;
  busy: boolean;
  /** The server's new list, so the panel shows the capture straight away. */
  onChange: (points: string[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const points = deal.painPoints ?? [];
  const inDemo = deal.stage === "demo";
  const inDiscovery = deal.stage === "discovery";

  return (
    <section className="mb-3 rounded-xl border border-[var(--border)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">
            {inDemo ? "Build the demo around these" : "What hurts"}
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {inDemo
              ? "Their words, captured in Discovery. Show each one stopping."
              : "Captured in Discovery, in their words — not yours."}
          </p>
        </div>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="btn-soft focus-ring shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium"
          >
            Add
          </button>
        )}
      </div>

      {points.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-1.5">
          {points.map((point, i) => (
            /* Keyed by text AND index: the same complaint captured twice is
               real, and a text-only key would collapse the two into one row. */
            <li
              key={`${point}-${i}`}
              className="group flex items-start justify-between gap-2 rounded-lg px-3 py-2"
              style={{ background: inDemo ? "var(--amber-soft)" : "var(--surface-2)" }}
            >
              <span className="min-w-0 text-sm">{point}</span>
              <form
                action={async () => {
                  setError(null);
                  const result = await removePainPointAction(deal.id, point);
                  if ("error" in result && result.error) setError(result.error);
                  else if (result.painPoints) onChange(result.painPoints);
                }}
              >
                <button
                  type="submit"
                  disabled={busy}
                  aria-label={`Remove "${point}"`}
                  /* Same hover-only trap as the card's delete button: on a
                     phone there is no hover, so a pain point could be added
                     and never removed. */
                  className="shrink-0 text-faint opacity-0 transition-opacity hover:text-[var(--red)] focus:opacity-100 group-hover:opacity-100 disabled:opacity-40 max-sm:opacity-100"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </form>
            </li>
          ))}
        </ul>
      ) : (
        <p
          className="mt-3 rounded-lg px-3 py-2 text-xs"
          style={
            inDemo
              ? { background: "var(--amber-soft)", color: "var(--amber)" }
              : { color: "var(--faint)" }
          }
        >
          {inDemo
            ? "Nothing was captured in Discovery, so this demo has nothing to anchor to. It will be a feature tour."
            : inDiscovery
              ? "Ask what is costing them time or money, and write it down as they say it."
              : "Nothing captured yet."}
        </p>
      )}

      {adding && (
        <form
          action={async (formData: FormData) => {
            setError(null);
            const result = await addPainPointsAction(deal.id, formData);
            if ("error" in result && result.error) setError(result.error);
            else if (result.painPoints) {
              onChange(result.painPoints);
              setAdding(false);
            }
          }}
          className="mt-3"
        >
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">
              One per line — how they said it
            </span>
            <textarea
              name="painPoints"
              rows={3}
              required
              autoFocus
              placeholder={"Leads go cold before anyone calls them\nNo idea which ads actually pay"}
              className="field-input resize-y"
            />
          </label>
          {error && (
            <p className="mt-2 text-xs" style={{ color: "var(--red)" }}>
              {error}
            </p>
          )}
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => { setAdding(false); setError(null); }}
              className="btn-soft focus-ring rounded-lg px-3 py-1.5 text-xs font-medium"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="btn-accent focus-ring rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-60"
            >
              Capture
            </button>
          </div>
        </form>
      )}

      {error && !adding && (
        <p className="mt-2 text-xs" style={{ color: "var(--red)" }}>
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * Closing the loop: who else has this problem?
 *
 * Offered in Delivery and Referral, and nowhere else. Asking during Discovery
 * is asking a stranger for a favour; asking once the work is done and visibly
 * working is asking a happy customer an easy question — and it is the cheapest
 * pipeline there is.
 *
 * The Referral column's exit condition has always read "Feeds back into
 * Prospect". Nothing made that happen, so the cycle ran in somebody's head or,
 * far more often, not at all. This is the step that makes the board's own
 * promise true.
 *
 * What the referrer says about the person is kept as the new prospect's first
 * pain point. It is the closest thing to Discovery that exists before Discovery
 * happens, and it is exactly what to open the first call with.
 */
function AskForReferral({ deal, busy }: { deal: Deal; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Post-close only. `wonAt` rather than the column, so a deal that has moved
  // on to Delivery or Referral still qualifies.
  if (deal.stage !== "delivery" && deal.stage !== "referral") return null;

  return (
    <section className="mb-3 rounded-xl border border-[var(--border)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">Who else has this problem?</p>
          <p className="mt-0.5 text-xs text-muted">
            {done
              ? "Added to Prospect, credited to this client."
              : "The work is done and working. This is the moment to ask."}
          </p>
        </div>
        {!open && !done && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="btn-accent focus-ring shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold"
          >
            Add referral
          </button>
        )}
      </div>

      {open && (
        <form
          action={async (formData: FormData) => {
            setError(null);
            const result = await recordReferralAction(deal.id, formData);
            if ("error" in result && result.error) setError(result.error);
            else {
              setDone(result.dealId ?? "");
              setOpen(false);
            }
          }}
          className="mt-3 space-y-3"
        >
          <div className="grid grid-cols-1 gap-3 @min-[420px]:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted">First name</span>
              <input name="firstName" required autoFocus className="field-input" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted">Last name</span>
              <input name="lastName" className="field-input" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted">Email (optional)</span>
              <input name="email" type="email" className="field-input" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted">Phone (optional)</span>
              <input name="phone" className="field-input" />
            </label>
          </div>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">
              What did they say about them?
            </span>
            <textarea
              name="note"
              rows={2}
              placeholder="Same problem with missed calls — runs two branches"
              className="field-input resize-y"
            />
          </label>

          {error && <p className="text-xs" style={{ color: "var(--red)" }}>{error}</p>}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => { setOpen(false); setError(null); }}
              className="btn-soft focus-ring rounded-lg px-3 py-1.5 text-xs font-medium"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="btn-accent focus-ring rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-60"
            >
              Create prospect
            </button>
          </div>
        </form>
      )}

      {done && (
        <p
          className="mt-3 rounded-lg px-3 py-2 text-xs"
          style={{ background: "var(--green-soft)", color: "var(--green)" }}
        >
          They are in Prospect now, and this client is credited with the referral.
        </p>
      )}
    </section>
  );
}

/* ---------------- Add Deal modal ---------------- */

function AddDealModal({
  busy,
  defaultStage,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  defaultStage: StageId;
  onClose: () => void;
  onSubmit: (formData: FormData) => void | Promise<void>;
}) {
  const [stage, setStage] = useState<StageId>(defaultStage);
  const showsMoney = carriesMoney(stage);

  return (
    <Overlay>
      <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true">
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
        {/* Opaque — see the note on `.modal-surface`. */}
        <form action={onSubmit} className="modal-surface relative z-10 w-full max-w-md p-6">
          <div className="mb-5 flex items-center justify-between">
            <h2 className="text-lg font-semibold tracking-tight">Add Deal</h2>
            <button type="button" onClick={onClose} className="text-faint hover:text-[var(--text)]" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="space-y-4">
            <Field name="title" label="Deal Title" required autoFocus placeholder="e.g. Website Redesign" />
            <div className="grid grid-cols-2 gap-4">
              <Field name="contact" label="Contact" placeholder="Full name" />
              <Field name="company" label="Company" placeholder="Company" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-muted">Stage</span>
                <select
                  name="stage"
                  value={stage}
                  onChange={(e) => setStage(e.target.value as StageId)}
                  className="w-full rounded-xl border border-[var(--border)] bg-[var(--panel-solid)] px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-[var(--border-strong)]"
                >
                  {STAGES.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>

              {/* The value field only exists where a value can. Leaving it
                  enabled on Leads In invited a number the pipeline then had to
                  throw away. */}
              {showsMoney ? (
                <Field name="value" label="Value ($)" type="number" placeholder="10000" />
              ) : (
                <div className="self-end pb-2.5 text-xs text-faint">
                  No value at this stage — added when you quote.
                </div>
              )}
            </div>
          </div>

          <div className="mt-6 flex items-center justify-end gap-3">
            <button type="button" onClick={onClose} className="btn-soft focus-ring rounded-xl px-5 py-2.5 text-sm font-medium">
              Cancel
            </button>
            <button type="submit" disabled={busy} className="btn-accent focus-ring rounded-xl px-5 py-2.5 text-sm font-semibold disabled:opacity-60">
              {busy ? "Saving…" : "Add Deal"}
            </button>
          </div>
        </form>
      </div>
    </Overlay>
  );
}

function Field({
  name,
  label,
  type = "text",
  required,
  autoFocus,
  placeholder,
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted">
        {label}
        {required && <span className="text-[var(--red)]"> *</span>}
      </span>
      <input
        name={name}
        type={type}
        required={required}
        autoFocus={autoFocus}
        placeholder={placeholder}
        min={type === "number" ? 0 : undefined}
        className="field-input"
      />
    </label>
  );
}
