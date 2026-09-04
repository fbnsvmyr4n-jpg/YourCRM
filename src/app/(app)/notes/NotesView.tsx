"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Building2, Handshake, KanbanSquare, NotebookPen, Search, Users } from "lucide-react";
import { Card, CardHeader, CardMeta } from "@/components/ui/Card";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { clsx } from "@/lib/clsx";
import type { NoteEntry, NoteSubject } from "@/server/notes-view";

/**
 * Everything written down, in one place.
 *
 * Deliberately not on Home: a note is not a daily-glance figure, it is
 * something you come looking for — usually because you half-remember it. So the
 * page is built around FINDING rather than browsing, and search is the first
 * thing on it rather than a filter tucked in a corner.
 *
 * Each row says what it is about and opens that record. A note stripped of its
 * subject is the weakest version of itself: "wants it split over two invoices"
 * is worth nothing if you cannot tell who said it.
 */

const ICON: Record<NoteSubject, typeof Users> = {
  contact: Users,
  meeting: Handshake,
  deal: KanbanSquare,
  company: Building2,
};

const NOUN: Record<NoteSubject, string> = {
  contact: "Contact",
  meeting: "Meeting",
  deal: "Deal",
  company: "Company",
};

type Filter = "all" | NoteSubject;

export function NotesView({ notes }: { notes: NoteEntry[] }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  /* Only the kinds actually present. A filter for "Company" on an account with
     no company notes is a control that can only ever empty the list. */
  const kinds = useMemo(() => {
    const seen = new Set<NoteSubject>();
    for (const n of notes) seen.add(n.kind);
    return (["contact", "meeting", "deal", "company"] as NoteSubject[]).filter((k) => seen.has(k));
  }, [notes]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return notes.filter((n) => {
      if (filter !== "all" && n.kind !== filter) return false;
      if (!q) return true;
      // The subject counts as much as the body — "find Jordan's notes" is the
      // same search as "find the note about invoices".
      return n.body.toLowerCase().includes(q) || n.subject.toLowerCase().includes(q);
    });
  }, [notes, query, filter]);

  return (
    <div className="mx-auto w-full max-w-5xl px-1 py-1">
      <header className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Notes</h1>
        <p className="mt-1 text-sm text-muted">
          Everything you have written down, against the contact, meeting or deal it belongs to.
        </p>
      </header>

      <Card>
        <CardHeader
          title="All notes"
          icon={<NotebookPen className="h-[18px] w-[18px] text-accent" />}
          action={<CardMeta value={notes.length}>{notes.length === 1 ? "note" : "notes"}</CardMeta>}
        />

        {notes.length === 0 ? (
          <p className="py-10 text-center text-sm text-faint">
            No notes yet. Add one from a contact, a deal or a meeting and it will appear here.
          </p>
        ) : (
          <>
            {/* Search first, because this page exists to answer "where was that
                thing I wrote". */}
            <label className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search notes and who they are about…"
                className="field-input"
                /*
                   Inline, not `pl-9`.

                   `.field-input` sets the SHORTHAND `padding: 10px 14px`, and
                   both it and a Tailwind utility are single-class selectors —
                   so source order decides and the utility loses. The class
                   applied cleanly in the markup and did nothing on screen: the
                   placeholder ran underneath the magnifier. An inline style
                   cannot be out-ordered.
                */
                style={{ paddingLeft: 36 }}
                aria-label="Search notes"
              />
            </label>

            {kinds.length > 1 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {(["all", ...kinds] as Filter[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setFilter(k)}
                    aria-pressed={filter === k}
                    className={clsx(
                      "focus-ring rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                      filter === k ? "text-accent" : "text-muted hover:text-[var(--text)]"
                    )}
                    style={filter === k ? { background: "var(--accent-soft)" } : undefined}
                  >
                    {k === "all" ? "All" : `${NOUN[k]}s`}
                  </button>
                ))}
              </div>
            )}

            {shown.length === 0 ? (
              <p className="py-10 text-center text-sm text-faint">
                Nothing matches “{query.trim()}”.
              </p>
            ) : (
              <ul className="mt-4 flex flex-col gap-2">
                {shown.map((n) => {
                  const Icon = ICON[n.kind];
                  return (
                    <li key={n.id}>
                      <Link
                        href={n.href}
                        className="focus-ring block rounded-xl border border-[var(--border)] p-3 transition-colors hover:border-[var(--border-strong)]"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="flex min-w-0 items-center gap-2">
                            <Icon className="h-3.5 w-3.5 shrink-0 text-accent" />
                            <span className="truncate text-sm font-semibold">{n.subject}</span>
                            <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold text-muted"
                                  style={{ background: "var(--raise)" }}>
                              {NOUN[n.kind]}
                            </span>
                          </span>
                          <TimeAgo at={n.at} mode="relative" className="shrink-0 text-[11px] text-faint" />
                        </div>
                        {/* `whitespace-pre-line` because notes are typed with
                            line breaks and flattening them loses the shape the
                            writer gave it. */}
                        <p className="mt-1.5 whitespace-pre-line text-sm text-muted">{n.body}</p>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
