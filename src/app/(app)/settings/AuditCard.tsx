"use client";

import { useMemo, useState } from "react";
import { ScrollText } from "lucide-react";
import { Card, CardHeader, CardMeta } from "@/components/ui/Card";
import type { AuditEvent } from "@/server/repos/audit";

/**
 * Who changed what, and when.
 *
 * Read-only by construction: the table refuses edits. It names records and
 * never shows their contents — the same rule as the log it is built from — so
 * IT can read it without seeing a customer's details.
 */

const VERB: Record<string, string> = {
  create: "added",
  update: "changed",
  delete: "deleted",
  restore: "restored",
  draft: "drafted",
  approve: "approved",
  send: "sent",
};

const plain = (entity: string) => entity.replace(/_/g, " ");

export function AuditCard({ events, timeZone, pageSize }: { events: AuditEvent[]; timeZone: string; pageSize: number }) {
  const [who, setWho] = useState("");
  const [what, setWhat] = useState("");

  const people = useMemo(
    () => [...new Map(events.filter((e) => e.actorId).map((e) => [e.actorId!, e.actorName ?? "Someone who has left"])).entries()],
    [events]
  );
  const kinds = useMemo(() => [...new Set(events.map((e) => e.entity))].sort(), [events]);
  const shown = events.filter((e) => (!who || e.actorId === who) && (!what || e.entity === what));

  const when = (iso: string) =>
    new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

  return (
    <Card>
      <CardHeader
        title="Audit log"
        icon={<ScrollText className="h-[18px] w-[18px] text-accent" />}
        action={events.length > 0 ? <CardMeta>{events.length === pageSize ? `latest ${pageSize}` : events.length}</CardMeta> : undefined}
      />
      {events.length === 0 ? (
        <p className="text-sm text-muted">
          Nothing recorded yet. Every change made in this workspace from now on is listed here — who made it, to which record,
          and when.
        </p>
      ) : (
        <>
          <div className="mb-3 grid grid-cols-1 gap-2 @min-[520px]:grid-cols-2">
            <select value={who} onChange={(e) => setWho(e.target.value)} className="field-input" aria-label="Filter by person">
              <option value="">Everyone</option>
              {people.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
            <select value={what} onChange={(e) => setWhat(e.target.value)} className="field-input" aria-label="Filter by kind of record">
              <option value="">Every kind of record</option>
              {kinds.map((k) => (
                <option key={k} value={k} className="capitalize">
                  {plain(k)}
                </option>
              ))}
            </select>
          </div>
          <ul className="flex flex-col divide-y divide-[var(--border)]">
            {shown.map((e) => (
              <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2.5 text-sm">
                <span className="w-28 shrink-0 text-xs tabular-nums text-faint">{when(e.at)}</span>
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{e.actorName ?? (e.detail?.startsWith("Public visitor") ? "Public visitor" : "The system")}</span>{" "}
                  <span className="text-muted">
                    {VERB[e.action] ?? e.action} {plain(e.entity).match(/^[aeiou]/i) ? "an" : "a"} {plain(e.entity)}
                  </span>
                  {e.detail && !e.detail.startsWith("Public visitor") && <span className="text-faint"> — {e.detail}</span>}
                </span>
                {e.entityId && <code className="shrink-0 truncate text-[11px] text-faint">{e.entityId}</code>}
              </li>
            ))}
          </ul>
          {shown.length === 0 && <p className="text-sm text-muted">No changes match those filters.</p>}
        </>
      )}
    </Card>
  );
}
