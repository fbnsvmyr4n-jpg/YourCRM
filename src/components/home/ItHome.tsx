import Link from "next/link";
import { Activity, CheckCircle2, ChevronRight, CircleAlert, KeyRound, ScrollText, Users } from "lucide-react";
import { Card, CardHeader, CardMeta, ViewAll } from "@/components/ui/Card";
import type { ItHomeAgency, ItHomeTenant } from "@/server/role-home";
import { RoleGreeting } from "./RoleGreeting";

/**
 * IT's first screen.
 *
 * One question: IS ANYTHING BROKEN, AND WHO CHANGED WHAT.
 *
 * No numbers in the greeting. IT does not watch a figure go up through the
 * day the way finance watches money arrive; the useful thing to say first is a
 * STATE — running, or not, and if not, what. Four tiles reading zero would be
 * four small reassurances somebody has to read to learn nothing.
 *
 * Nothing here is customer data, and that is enforced upstream, not here: the
 * audit rows are filtered to account settings before they leave the server,
 * and the services list is configuration, never content.
 */

const ROLE_NAME: Record<string, string> = {
  owner: "Owner",
  admin: "IT admin",
  finance: "Finance",
  member: "Sales",
  viewer: "View only",
};

export function ItHome({
  tenant,
  agency,
  greeting,
  name,
  timeZone,
}: {
  tenant: ItHomeTenant;
  agency: ItHomeAgency;
  greeting: string;
  name: string;
  timeZone: string;
}) {
  const time = (iso: string) =>
    new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  const when = (iso: string) =>
    new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(
      new Date(iso)
    );

  /*
     WHAT NEEDS SOMEBODY — only things a person here can act on or must know.

     A service not being set up is NOT in this list. It is not broken; it was
     never switched on, and most of them are switched on outside this
     workspace. Listing "Email is not set up" every single day as an alert is
     the alarm that is always ringing — so services have their own card, stated
     as facts, and this list stays empty on a good day.
  */
  const attention = [
    tenant.failedDeliveries > 0 && {
      key: "deliveries",
      href: "/system",
      text: `${tenant.failedDeliveries} deliver${tenant.failedDeliveries === 1 ? "y" : "ies"} failed`,
      sub: "Gave up after retrying — retry or discard on System health",
    },
    tenant.stoppedAutomations > 0 && {
      key: "automations",
      href: "/system",
      text: `${tenant.stoppedAutomations} automation${tenant.stoppedAutomations === 1 ? "" : "s"} stopped`,
      sub: "A rule failed on its last run",
    },
    ...agency.lockedOut.map((l, i) => ({
      key: `locked-${i}`,
      href: "/settings?s=team",
      text: `${l.name} is locked out`,
      /* The answer to the call before it is made. It clears on its own; there
         is nothing to reset, and saying so stops a password being changed for
         no reason. */
      sub: `Too many wrong passwords — clears by itself at ${time(l.until)}`,
    })),
  ].filter(Boolean) as { key: string; href: string; text: string; sub: string }[];

  const status =
    attention.length === 0
      ? { tone: "green" as const, text: "Everything is running" }
      : { tone: "amber" as const, text: `${attention.length} thing${attention.length === 1 ? " needs" : "s need"} you` };

  /* Only when something IS queued. "Nothing queued to send" was a sentence
     under the greeting that told IT nothing, beside a pill that already said
     whether anything needed them. */
  const summary =
    tenant.waitingToSend > 0
      ? `${tenant.waitingToSend} message${tenant.waitingToSend === 1 ? " is" : "s are"} queued to send.`
      : undefined;

  return (
    <div className="flex flex-col gap-5">
      <RoleGreeting greeting={greeting} name={name} summary={summary} status={status} />

      <div className="grid grid-cols-1 items-start gap-5 @min-[820px]:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex flex-col gap-5">
          {/* ── Needs attention ──────────────────────────────────────── */}
          <Card>
            <CardHeader
              title="Needs attention"
              icon={<CircleAlert className="h-[18px] w-[18px] text-accent" />}
              action={<ViewAll href="/system">System health</ViewAll>}
            />
            {attention.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-muted">
                <CheckCircle2 className="h-4 w-4 shrink-0" style={{ color: "var(--green)" }} />
                No failed deliveries, no stopped automations, nobody locked out.
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {attention.map((a) => (
                  <li key={a.key}>
                    <Link
                      href={a.href}
                      className="focus-ring -mx-2 flex items-center gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-[var(--raise)]"
                    >
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg" style={{ background: "var(--amber-soft)" }}>
                        {a.key.startsWith("locked") ? (
                          <KeyRound className="h-4 w-4" style={{ color: "var(--amber)" }} />
                        ) : (
                          <Activity className="h-4 w-4" style={{ color: "var(--amber)" }} />
                        )}
                      </span>
                      <span className="min-w-0 flex-1 leading-tight">
                        <span className="block text-sm font-medium">{a.text}</span>
                        <span className="block text-xs text-faint">{a.sub}</span>
                      </span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-faint" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* ── Recent account changes ───────────────────────────────── */}
          <Card>
            <CardHeader
              title="Recent account changes"
              icon={<ScrollText className="h-[18px] w-[18px] text-accent" />}
              action={<ViewAll href="/settings?s=audit">Audit log</ViewAll>}
            />
            {tenant.changes.length === 0 ? (
              <p className="text-sm text-muted">
                No changes to people or settings yet. Role changes, removals, passwords and settings appear here as they happen.
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-[var(--border)]">
                {tenant.changes.map((c) => (
                  <li key={c.id} className="flex items-baseline gap-3 py-2 text-sm">
                    <span className="w-24 shrink-0 text-xs tabular-nums text-faint">{when(c.at)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{c.who}</span> <span className="text-muted">{c.what}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-5">
          {/* ── Services ─────────────────────────────────────────────── */}
          {/* Stated as facts, each with what it means. "Email: not set up" is
              half a sentence; "nothing can be emailed" is the half that
              explains the failed delivery on the left. */}
          <Card>
            <CardHeader title="Services" />
            <ul className="flex flex-col gap-2.5">
              {tenant.services.map((s) => (
                <li key={s.name} className="flex items-start gap-2.5 text-sm">
                  <span
                    aria-hidden
                    className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                    style={{ background: s.ok ? "var(--green)" : "var(--text-faint, var(--border-strong))" }}
                  />
                  <span className="min-w-0 leading-tight">
                    <span className="block font-medium">
                      {s.name}
                      <span className="sr-only">{s.ok ? " — working" : " — not available"}</span>
                    </span>
                    <span className="block text-xs text-faint">{s.says}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          {/* ── Team ─────────────────────────────────────────────────── */}
          <Card>
            <CardHeader
              title="Team"
              icon={<Users className="h-[18px] w-[18px] text-accent" />}
              action={<CardMeta value={agency.team.total}>{agency.team.total === 1 ? "person" : "people"}</CardMeta>}
            />
            <ul className="flex flex-wrap gap-2">
              {agency.team.byRole.map((r) => (
                <li
                  key={r.role}
                  className="rounded-full border border-[var(--border)] px-2.5 py-1 text-xs"
                  style={{ background: "var(--raise)" }}
                >
                  <span className="font-semibold tabular-nums">{r.count}</span>{" "}
                  <span className="text-muted">{ROLE_NAME[r.role] ?? r.role}</span>
                </li>
              ))}
            </ul>
            <div className="mt-3">
              <ViewAll href="/settings?s=team">Manage the team</ViewAll>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
