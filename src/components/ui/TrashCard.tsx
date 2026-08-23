"use client";

import { useState, useTransition } from "react";
import { Building2, CalendarClock, Phone, RotateCcw, Trash2, UserRound, Handshake } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/Card";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { Banner } from "@/components/ui/Banner";
import { restoreDeletedAction } from "@/app/(app)/settings/actions";
import type { TrashItem, TrashKind } from "@/server/trash";

/**
 * Recently deleted, and the way back.
 *
 * Every delete in the product has been soft for weeks — the row is stamped and
 * kept — but nothing in the interface could reach the restore functions, so in
 * practice a mis-click was still permanent. This is the missing half.
 *
 * There is no "delete permanently" and no "empty" button, deliberately. This
 * screen exists because destroying a record by accident is the failure being
 * fixed; a control that destroys records for real, sitting one row away from the
 * one that saves them, would reintroduce it in a worse place.
 */

const ICONS: Record<TrashKind, React.ComponentType<{ className?: string }>> = {
  contact: UserRound,
  company: Building2,
  deal: Handshake,
  meeting: CalendarClock,
  call: Phone,
};

const NOUNS: Record<TrashKind, string> = {
  contact: "Contact",
  company: "Company",
  deal: "Deal",
  meeting: "Meeting",
  call: "Call",
};

export function TrashCard({ items }: { items: TrashItem[] }) {
  // Restored rows leave the list immediately rather than waiting for the page
  // to revalidate. The row that just came back is the one thing on screen the
  // reader is certain about, and leaving it sitting there under a spinner reads
  // as a failure.
  const [restored, setRestored] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const visible = items.filter((i) => !restored.has(`${i.kind}:${i.id}`));

  function restore(item: TrashItem) {
    const key = `${item.kind}:${item.id}`;
    setBusy(key);
    setError(null);
    startTransition(async () => {
      const result = await restoreDeletedAction(item.kind, item.id);
      setBusy(null);
      if (result?.error) setError(result.error);
      else setRestored((prev) => new Set(prev).add(key));
    });
  }

  return (
    <Card className="card-q">
      <CardHeader
        title="Recently deleted"
        icon={<Trash2 className="h-[18px] w-[18px] text-accent" />}
      />

      {visible.length === 0 ? (
        <p className="text-sm text-faint">
          Nothing has been deleted in this workspace. When something is, it will wait here
          rather than disappearing.
        </p>
      ) : (
        <>
          <p className="mb-4 text-sm text-faint">
            Deleting hides a record; it does not destroy it. Anything below can be put back
            exactly as it was.
          </p>
          {error ? (
            <div className="mb-3">
              <Banner state={{ error }} />
            </div>
          ) : null}
          <ul className="divide-y divide-[var(--border)]">
            {visible.map((item) => {
              const key = `${item.kind}:${item.id}`;
              const Icon = ICONS[item.kind];
              return (
                <li key={key} className="flex items-center gap-3 py-3">
                  <Icon className="h-4 w-4 shrink-0 text-faint" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{item.label}</p>
                    <p className="text-xs text-faint">
                      {NOUNS[item.kind]} · deleted <TimeAgo at={item.deletedAt} mode="relative" />
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => restore(item)}
                    disabled={busy === key}
                    className="focus-ring flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-accent transition-colors hover:bg-[var(--raise)] disabled:opacity-60"
                  >
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                    {busy === key ? "Restoring…" : "Restore"}
                    <span className="sr-only"> {NOUNS[item.kind]}: {item.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {/* Said here rather than discovered afterwards: removing a company
              clears the link on everyone who belonged to it, and nothing records
              who they were, so it cannot come back with its people. */}
          {visible.some((i) => i.kind === "company") ? (
            <p className="mt-4 text-xs text-faint">
              A restored company comes back without its members — removing it cleared the
              link on each contact, and those people are unaffected either way.
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}
