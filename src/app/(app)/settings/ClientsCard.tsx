"use client";

import { useState } from "react";
import { Briefcase, ChevronDown, UserRoundX } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Card, CardHeader, CardMeta } from "@/components/ui/Card";
import { clsx } from "@/lib/clsx";
import type { Book } from "@/server/clients-view";

/**
 * Who is looking after whom.
 *
 * Every colleague, and the contacts assigned to them. The question it answers
 * is one the product could not answer at all: two reps ring the same company in
 * a week, somebody leaves and forty relationships have nobody's name against
 * them, and neither is visible anywhere until it goes wrong.
 *
 * A fold per person rather than one long list. Five people with twenty contacts
 * each is a hundred rows, and the standing rule for this product is that a
 * screen should not have to be scrolled to be understood. Closed, it is a short
 * roster with a count and a figure against each name — which is the answer to
 * "who belongs to who" on its own. Open, it is the names.
 *
 * The reader's own book starts open, because "what am I carrying" is the
 * commonest reason to be here.
 */

/** Compact money, matching the Reports cards. Whole units — cents are noise here. */
function money(cents: number): string {
  const n = Math.round(cents / 100);
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `$${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return `$${n}`;
}

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase() || "?";

export function ClientsCard({ books, readerId }: { books: Book[]; readerId: string }) {
  const assigned = books.reduce((n, b) => n + (b.owner ? b.entries.length : 0), 0);
  const unowned = books.find((b) => !b.owner)?.entries.length ?? 0;

  return (
    <>
      <Card>
        <CardHeader
          title="Books of business"
          icon={<Briefcase className="h-[18px] w-[18px] text-accent" />}
          action={<CardMeta value={assigned}>assigned</CardMeta>}
        />

        {books.length === 0 ? (
          <p className="text-xs text-faint">
            Nobody has any contacts assigned yet. Assign an owner on a contact and they will
            appear here.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {books.map((book) => (
              <BookRow
                key={book.owner?.id ?? "unassigned"}
                book={book}
                isYou={book.owner?.id === readerId}
                defaultOpen={book.owner?.id === readerId}
              />
            ))}
          </ul>
        )}
      </Card>

      {/*
          Unassigned contacts get their own note, not just a row in the list.

          This is the number the screen exists to surface: a contact nobody owns
          is one nobody is going to ring. Stated as a fact with a way to fix it
          rather than as a warning — it is a normal state for a fresh import,
          not a fault.
      */}
      {unowned > 0 && (
        <Card>
          <CardHeader
            title="Nobody's yet"
            icon={<UserRoundX className="h-[18px] w-[18px]" style={{ color: "var(--amber)" }} />}
            action={<CardMeta value={unowned}>contacts</CardMeta>}
          />
          <p className="text-xs text-faint">
            {unowned === 1 ? "One contact has" : `${unowned} contacts have`} no owner. Open a
            contact and set one, and they will move into that person&apos;s book.
          </p>
        </Card>
      )}
    </>
  );
}

function BookRow({
  book,
  isYou,
  defaultOpen,
}: {
  book: Book;
  isYou: boolean;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const { owner, entries, clientCount, wonValueCents } = book;
  const bodyId = `book-${owner?.id ?? "unassigned"}`;
  const name = owner?.name ?? "Unassigned";

  return (
    <li className="overflow-hidden rounded-xl" style={{ background: isYou ? "var(--accent-soft)" : "var(--surface-2)" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={bodyId}
        /* The whole row is the control. A chevron alone is a small target on a
           phone, and there is nothing else on the row to click. */
        /* `gap-2.5` and the tighter chip padding below are not taste. Measured
           at 375px: the row's furniture came to 176px of a 265px content box,
           leaving 89px for a subtitle that needs 102 — so "Account Executive"
           clipped on exactly the person who has both a count and a figure.
           Sixteen pixels reclaimed here and in the chips gives it 109. */
        className="focus-ring flex w-full items-center gap-2.5 px-3.5 py-3 text-left"
      >
        {owner ? (
          <Avatar initials={initialsOf(owner.name)} color={isYou ? "blue" : "teal"} size="sm" />
        ) : (
          <span
            className="grid h-8 w-8 shrink-0 place-items-center rounded-xl"
            style={{ background: "var(--amber-soft)", color: "var(--amber)" }}
          >
            <UserRoundX className="h-4 w-4" />
          </span>
        )}

        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-sm font-medium">
            {name}
            {isYou && <span className="ml-2 text-xs font-normal text-faint">you</span>}
          </span>
          {/* The job title if it is filled in, otherwise the department. A line
              that says "—" is a line spent on an em dash. */}
          <span className="mt-0.5 block truncate text-xs text-faint">
            {owner?.jobTitle ?? owner?.department ?? (owner ? "No position set" : "No owner set")}
          </span>
        </span>

        {/*
            The count and the money, always on the name's line.

            Three versions of this row were measured. Chips at full width wrapped
            to a third line at 375px and every person cost 110px — seven people
            and the roster stopped fitting on a screen, which is the one rule
            this product does not bend. Folding the count into the subtitle
            fixed the height and broke the text instead: "Head of Sales · 1
            cont…".

            What actually fits is the count keeping its chip and losing its
            NOUN. A bare "3" is about 28px, so the name keeps roughly 200px at
            375 and nothing truncates; from 440 the word comes back. The number
            is the same expression either way, so the two cannot disagree.
        */}
        <span className="flex shrink-0 items-center gap-1.5">
          <span className="shrink-0 whitespace-nowrap rounded-full border border-[var(--border-strong)] px-2 py-1 text-xs font-medium text-muted @min-[440px]:px-2.5" style={{ background: "var(--raise)" }}>
            <span className="font-semibold tabular-nums text-[var(--text)]">
              {entries.length}
            </span>
            <span className="hidden @min-[440px]:inline">
              {" "}
              {entries.length === 1 ? "contact" : "contacts"}
            </span>
          </span>
          {/* Only when there is money. A row of $0 against every new starter is
              a column of zeroes that says nothing. */}
          {wonValueCents > 0 && (
            <span
              className="shrink-0 whitespace-nowrap rounded-full px-2 py-1 text-xs font-semibold tabular-nums @min-[440px]:px-2.5"
              style={{ background: "var(--green-soft)", color: "var(--green)" }}
            >
              {money(wonValueCents)}
            </span>
          )}
          <ChevronDown
            className={clsx("h-4 w-4 shrink-0 text-muted transition-transform", open && "rotate-180")}
            aria-hidden
          />
        </span>
      </button>

      {open && (
        <div id={bodyId} className="border-t border-[var(--border)] px-3.5 py-3">
          {entries.length === 0 ? (
            <p className="text-xs text-faint">
              Nothing assigned yet. An empty book is worth seeing — it usually means somebody has
              just started, or just handed everything over.
            </p>
          ) : (
            <>
              {clientCount > 0 && (
                <p className="mb-2 text-xs text-faint">
                  <span className="font-semibold text-[var(--text)]">{clientCount}</span> of{" "}
                  {entries.length} {entries.length === 1 ? "has" : "have"} bought.
                </p>
              )}
              <ul className="flex flex-col gap-1.5">
                {entries.map((e) => (
                  <li
                    key={e.id}
                    className="flex flex-wrap items-center gap-2 rounded-lg px-2.5 py-2"
                    style={{ background: "var(--raise)" }}
                  >
                    <span className="min-w-0 flex-1 leading-tight">
                      <span className="block truncate text-sm">{e.name}</span>
                      {(e.company || e.email) && (
                        <span className="mt-0.5 block truncate text-xs text-faint">
                          {e.company ?? e.email}
                        </span>
                      )}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {e.wonValueCents > 0 && (
                        <span className="text-xs font-semibold tabular-nums text-green">
                          {money(e.wonValueCents)}
                        </span>
                      )}
                      {/* One badge, not three. `Client` beats `Open` because
                          having bought is the more important fact; somebody who
                          has bought AND has a live deal is still a client. */}
                      {e.isClient ? (
                        <Badge color="var(--green)" soft="var(--green-soft)">
                          Client
                        </Badge>
                      ) : e.hasOpenDeal ? (
                        <Badge color="var(--accent)" soft="var(--accent-soft)">
                          In play
                        </Badge>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </li>
  );
}

function Badge({
  color,
  soft,
  children,
}: {
  color: string;
  soft: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className="whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold"
      style={{ background: soft, color }}
    >
      {children}
    </span>
  );
}
