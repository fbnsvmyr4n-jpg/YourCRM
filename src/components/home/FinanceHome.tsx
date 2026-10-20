import Link from "next/link";
import { AlarmClock, ArrowDownLeft, ChevronRight, Mail, Receipt, Wallet } from "lucide-react";
import { Card, CardHeader, CardMeta, ViewAll } from "@/components/ui/Card";
import { formatMoney, type CurrencyCode } from "@/lib/money";
import type { FinanceHome as Data } from "@/server/role-home";
import { RoleGreeting } from "./RoleGreeting";

/**
 * The bookkeeper's first screen.
 *
 * One question: WHO OWES US, AND WHO DO I CHASE TODAY.
 *
 * Until this existed the answer was nowhere a bookkeeper could reach. Overdue
 * invoices raise "Chase INV-…" tasks — on the Tasks screen, which is customer
 * work, which finance cannot open. So the system noticed a late payment, wrote
 * itself a reminder, and handed it to the one place the person it was for
 * could never look.
 *
 * Deliberately NOT here: a revenue chart, pipeline, deals, quick-action tiles.
 * Revenue is a sales question; a bookkeeper's is cash. And every shortcut a
 * home page might offer is already a row in the sidebar one glance to the
 * left — a second copy of the navigation is clutter wearing a button.
 */
export function FinanceHome({
  data,
  currency,
  greeting,
  name,
  monthName,
  timeZone,
}: {
  data: Data;
  currency: CurrencyCode;
  greeting: string;
  name: string;
  monthName: string;
  timeZone: string;
}) {
  const money = (c: number) => formatMoney(c, currency, "exact");
  const chaseShown = data.chase.slice(0, 6);
  const overdueCount = data.chase.length;

  /* The sentence a person reads first, so it says the thing that needs doing. */
  const summary =
    overdueCount > 0
      ? `${overdueCount} invoice${overdueCount === 1 ? " is" : "s are"} overdue — ${money(data.overdueCents)} to chase.`
      : data.outstandingCount > 0
        ? `Nothing overdue. ${data.outstandingCount} invoice${data.outstandingCount === 1 ? "" : "s"} still inside ${data.outstandingCount === 1 ? "its" : "their"} terms.`
        : "Nobody owes you anything right now.";

  const waiting = [
    data.draftInvoices.count > 0 && {
      href: "/invoices",
      icon: Receipt,
      text: `${data.draftInvoices.count} draft invoice${data.draftInvoices.count === 1 ? "" : "s"} not sent`,
      sub: `${money(data.draftInvoices.cents)} — not owed until sent`,
    },
    data.draftCredits > 0 && {
      href: "/credit-notes",
      icon: ArrowDownLeft,
      text: `${data.draftCredits} credit note${data.draftCredits === 1 ? "" : "s"} not issued`,
      sub: "Taking nothing off the bill until issued",
    },
    data.unread !== null &&
      data.unread > 0 && {
        href: "/inbox",
        icon: Mail,
        text: `${data.unread} unread message${data.unread === 1 ? "" : "s"}`,
        sub: "In the inbox",
      },
  ].filter(Boolean) as { href: string; icon: typeof Mail; text: string; sub: string }[];

  /* A calendar date, not an instant — formatted in UTC so it cannot shift a
     day either side of whatever zone the server is in. */
  const dueDay = (ymd: string) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" }).format(
      new Date(`${ymd}T00:00:00Z`)
    );
  const paidDay = (iso: string) =>
    new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short" }).format(new Date(iso));

  return (
    <div className="flex flex-col gap-5">
      <RoleGreeting
        greeting={greeting}
        name={name}
        summary={summary}
        tiles={[
          {
            icon: Wallet,
            tone: "blue",
            label: "Outstanding",
            value: money(data.outstandingCents),
            sub: `${data.outstandingCount} invoice${data.outstandingCount === 1 ? "" : "s"}`,
          },
          {
            icon: AlarmClock,
            /* Red only when it is true. A red zero is an alarm about nothing,
               and an alarm that is usually wrong stops being read. */
            tone: overdueCount > 0 ? "red" : "green",
            label: "Overdue",
            value: money(data.overdueCents),
            sub: overdueCount > 0 ? `${overdueCount} to chase` : "none late",
          },
          {
            icon: ArrowDownLeft,
            tone: "green",
            label: `Received in ${monthName}`,
            value: money(data.receivedThisMonthCents),
            /* Last month for scale — a figure on its own says nothing about
               whether this is a good month or a bad one. */
            sub: `${money(data.receivedLastMonthCents)} last month`,
          },
        ]}
      />

      {/* `items-start`: each card is as tall as what it holds. Stretched to the
          right column, an empty To chase became a large blank panel — which
          reads as something failed to load rather than as good news. */}
      <div className="grid grid-cols-1 items-start gap-5 @min-[820px]:grid-cols-[minmax(0,1fr)_380px]">
        {/* ── To chase ───────────────────────────────────────────────── */}
        <Card>
          <CardHeader
            title="To chase"
            icon={<AlarmClock className="h-[18px] w-[18px] text-accent" />}
            action={
              overdueCount > 0 ? <CardMeta value={overdueCount}>overdue</CardMeta> : <ViewAll href="/invoices">All invoices</ViewAll>
            }
          />
          {chaseShown.length === 0 ? (
            <p className="text-sm text-muted">
              {data.outstandingCount > 0
                ? "Nothing is past its due date. Anything that slips will appear here, oldest first."
                : "No invoice is waiting on payment. When one goes past its due date it appears here, oldest first."}
            </p>
          ) : (
            <>
              <ul className="flex flex-col divide-y divide-[var(--border)]">
                {chaseShown.map((c) => (
                  <li key={c.id} className="flex items-center gap-3 py-2.5">
                    {/* Name on its own truncating line, and the lateness kept
                        whole. On a phone "Amara Dube" broke across two lines and
                        the date split as "2026-09-" / "12". */}
                    <div className="min-w-0 flex-1 leading-snug">
                      <p className="truncate">
                        <Link href={`/documents/${c.id}`} className="focus-ring rounded font-medium hover:underline">
                          {c.number}
                        </Link>
                        <span className="text-muted"> · {c.party ?? "No client named"}</span>
                      </p>
                      <p
                        className="whitespace-nowrap text-xs"
                        style={{ color: c.daysLate > 30 ? "var(--red)" : "var(--amber)" }}
                      >
                        {c.daysLate} day{c.daysLate === 1 ? "" : "s"} late · due {dueDay(c.dueOn)}
                      </p>
                    </div>
                    <span className="shrink-0 text-sm font-semibold tabular-nums">{money(c.owedCents)}</span>
                    {/* Straight into a message to them, already addressed and
                        titled. Only where there is an address — a button that
                        opens an empty "To" field is a chase that has not
                        started. */}
                    {c.email ? (
                      <Link
                        href={`/inbox?compose=1&to=${encodeURIComponent(c.email)}&subject=${encodeURIComponent(`${c.number} — payment overdue`)}`}
                        className="focus-ring shrink-0 rounded-lg px-2.5 py-1 text-xs font-semibold text-accent hover:opacity-80"
                        aria-label={`Email ${c.party ?? "the client"} about ${c.number}`}
                      >
                        Email
                      </Link>
                    ) : (
                      <span className="w-[46px] shrink-0 text-[11px] text-faint" title="No email address on this invoice or its contact">
                        No email
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {data.chase.length > chaseShown.length && (
                <div className="mt-2 text-right">
                  <ViewAll href="/invoices">{data.chase.length - chaseShown.length} more on Invoices</ViewAll>
                </div>
              )}
            </>
          )}
        </Card>

        <div className="flex flex-col gap-5">
          {/* ── Waiting on you ───────────────────────────────────────── */}
          {/* Only rows with something in them. A list of "0 drafts, 0 credit
              notes, 0 unread" is three lines saying nothing, and teaches the
              reader to skip the card on the day it does say something. */}
          <Card>
            <CardHeader title="Waiting on you" />
            {waiting.length === 0 ? (
              <p className="text-sm text-muted">Nothing waiting. No drafts to send and no unread mail.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {waiting.map((w) => {
                  const Icon = w.icon;
                  return (
                    <li key={w.href}>
                      <Link
                        href={w.href}
                        className="focus-ring -mx-2 flex items-center gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-[var(--raise)]"
                      >
                        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg" style={{ background: "var(--accent-soft)" }}>
                          <Icon className="h-4 w-4 text-accent" />
                        </span>
                        <span className="min-w-0 flex-1 leading-tight">
                          <span className="block text-sm font-medium">{w.text}</span>
                          <span className="block truncate text-xs text-faint">{w.sub}</span>
                        </span>
                        <ChevronRight className="h-4 w-4 shrink-0 text-faint" />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {/* ── Recently received ────────────────────────────────────── */}
          <Card>
            <CardHeader title="Recently received" action={<ViewAll href="/invoices">Invoices</ViewAll>} />
            {data.recent.length === 0 ? (
              <p className="text-sm text-muted">
                No payments yet. Card payments appear here by themselves; a transfer appears once you record it on the invoice.
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-[var(--border)]">
                {data.recent.map((p) => (
                  <li key={p.id} className="flex items-baseline gap-3 py-2 text-sm">
                    <span className="w-14 shrink-0 text-xs tabular-nums text-faint">{paidDay(p.paidAt)}</span>
                    <span className="min-w-0 flex-1 truncate">
                      <Link href={`/documents/${p.documentId}`} className="focus-ring rounded font-medium hover:underline">
                        {p.number}
                      </Link>
                      <span className="text-muted"> · {p.method}</span>
                    </span>
                    <span className="shrink-0 font-semibold tabular-nums" style={{ color: "var(--green)" }}>
                      {money(p.amountCents)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
