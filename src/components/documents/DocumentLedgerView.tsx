"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ClipboardList, FileText, Plus, Search } from "lucide-react";
import { Banner } from "@/components/ui/Banner";
import { Card, CardHeader, CardMeta } from "@/components/ui/Card";
import { clsx } from "@/lib/clsx";
import { useFormDisclosure } from "@/lib/form-disclosure";
import { useKeptForm } from "@/lib/use-kept-form";
import { useMoney } from "@/components/money/CurrencyProvider";
import type { DocumentStatus } from "@/server/repos/projects";
import type { LedgerRow } from "@/server/document-ledger";
import { createDocumentAction } from "@/app/(app)/projects/actions";
import { sendMyQuoteAction } from "@/app/(app)/quotes/actions";
import { sendOrderAction } from "@/app/(app)/purchase-orders/actions";
import type { FormState } from "@/app/(app)/projects/actions";

/**
 * Every quotation, or every purchase order, across all of a workspace's jobs.
 *
 * The project screen answers "what paperwork does this job have". This answers
 * the other question — "where is that quote" — asked without remembering which
 * job it was on, and "what have we committed this month" asked across all of
 * them.
 *
 * One component for both kinds because they differ only in vocabulary and in
 * which statuses count. Two near-identical screens would be two places for the
 * arithmetic to drift, which is the thing this feature most has to avoid.
 *
 * It creates through `createDocumentAction`, the SAME action the project screen
 * uses, rather than a second one shaped for this page. That action already
 * refuses a quantity or price it cannot read, rounds a decimal quantity to
 * three places to match the column, and converts money to cents once — all of
 * it learned from a purchase order that went out at R58,000 instead of
 * R50,750. A second create path would be a second chance to get that wrong.
 */

export type Ledger = {
  rows: LedgerRow[];
  countedCents: number;
  notCountedCents: number;
};

export type LedgerCopy = {
  kind: "quote" | "purchase_order";
  title: string;
  /** "quotation" / "purchase order", for sentences. */
  one: string;
  countedLabel: string;
  notCountedLabel: string;
  partyLabel: string;
};

type Project = { id: string; title: string; client: string | null };

/** How a status reads, and whether it is the sort that needs attention. */
const STATUS_TONE: Record<DocumentStatus, string> = {
  draft: "var(--text-muted)",
  awaiting_approval: "var(--amber)",
  approved: "var(--accent)",
  sent: "var(--accent)",
  accepted: "var(--green)",
  declined: "var(--red)",
  paid: "var(--green)",
  cancelled: "var(--text-muted)",
};

const statusLabel = (s: DocumentStatus) => s.replace(/_/g, " ");

/**
 * The statuses somebody may choose when RAISING one.
 *
 * Not every status a document can hold. `awaiting_approval` and `approved`
 * belong to the drafting flow — an agent wrote it, a named person signed it
 * off — and offering them here would let somebody skip the approval by
 * picking its outcome from a menu. `declined`, `cancelled` and `paid` are
 * things that happen to a document later, not states it is born in.
 *
 * It must also stay a subset of what `createDocumentAction` accepts, or the
 * form offers a value the server refuses. This product has already shipped a
 * control whose options disagreed with its own data once, and one press of
 * Update threw a pending approval away.
 */
const CREATE_STATUSES = ["draft", "sent", "accepted"] as const satisfies readonly DocumentStatus[];

/**
 * When Send is worth offering at all.
 *
 * `accepted` and `paid` happened AFTER it went; `declined` and `cancelled`
 * are a no. Offering Send on any of those would be offering to re-send
 * history. The action checks this again — a control is tidiness, the
 * refusal in the server is the rule.
 */
const SENDABLE_QUOTE: readonly DocumentStatus[] = ["draft", "awaiting_approval", "approved"];

/**
 * An order can go from any state that is not already gone or called off.
 *
 * Wider than a quotation's on purpose. A quotation must be approved before
 * it leaves; an order is already counted in a project's committed money
 * from the moment it is drafted, so drafting one WAS the decision.
 */
const SENDABLE_ORDER: readonly DocumentStatus[] = ["draft", "approved", "accepted"];

export function DocumentLedgerView({
  ledger,
  copy,
  projects,
  suggestedNumber,
  today,
}: {
  ledger: Ledger;
  copy: LedgerCopy;
  /** Every live job, so a new document can be filed against one. */
  projects: Project[];
  suggestedNumber: string;
  today: string;
}) {
  const { format } = useMoney();
  /**
   * Cents shown whenever there are any.
   *
   * The default "whole" style rounds, and this product has already printed
   * a R1,250.50 rate as R1,251 on a document somebody signs. A quotation of
   * R42,001.75 shown as R42,002 is the same mistake: 25c that the client's
   * copy will not agree with. `exact` drops the decimals when they are zero,
   * so a round figure still reads as a round figure.
   */
  const money = (cents: number) => format(cents, "exact");
  const [query, setQuery] = useState("");

  const form = useKeptForm<FormState>(createDocumentAction, undefined);
  /* One form per kind, chosen once rather than per row: a quotation needs
     approving on its way out and an order does not, and the two refusals
     read differently. */
  const sendQuote = useKeptForm<FormState>(sendMyQuoteAction, undefined);
  const sendOrder = useKeptForm<FormState>(sendOrderAction, undefined);
  const send = copy.kind === "quote" ? sendQuote : sendOrder;
  const [adding, openAdd, closeAdd] = useFormDisclosure(form.state, (s: FormState) => Boolean(s?.ok));

  const shown = useMemo(() => {
    const t = query.trim().toLowerCase();
    if (!t) return ledger.rows;
    return ledger.rows.filter(
      (r) =>
        r.number.toLowerCase().includes(t) ||
        (r.party ?? "").toLowerCase().includes(t) ||
        r.projectTitle.toLowerCase().includes(t)
    );
  }, [ledger.rows, query]);

  const Icon = copy.kind === "quote" ? FileText : ClipboardList;

  return (
    <div className="mx-auto flex max-w-[1500px] animate-fade-up flex-col gap-5">
      <div className="pt-1">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{copy.title}</h1>
        <p className="mt-1 text-sm text-muted">
          {copy.kind === "quote"
            ? "What you have offered clients, across every job."
            : "What you have committed to suppliers, across every job."}
        </p>
      </div>

      {/* The two figures, kept apart.

          A single heading total over a list containing a declined quotation is
          a number the reader cannot reconcile with what is in front of them.
          What counts is stated, and the rest is named as what it is. */}
      <div className="grid grid-cols-1 gap-3 @min-[560px]:grid-cols-2">
        <Card className="p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">
            {copy.countedLabel}
          </p>
          <p className="mt-1 text-3xl font-bold tracking-tight tabular-nums">
            {money(ledger.countedCents)}
          </p>
          <p className="mt-1 text-xs text-muted">
            {copy.kind === "quote"
              ? "Agreed by the client. Counted on every project."
              : "Ordered and not called off. Counted on every project."}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">
            {copy.notCountedLabel}
          </p>
          <p className="mt-1 text-3xl font-bold tracking-tight tabular-nums text-muted">
            {money(ledger.notCountedCents)}
          </p>
          <p className="mt-1 text-xs text-muted">
            Shown here, and deliberately not in any project&rsquo;s figures.
          </p>
        </Card>
      </div>

      <Card>
        <CardHeader
          title={copy.title}
          icon={<Icon className="h-[18px] w-[18px] text-accent" />}
          action={<CardMeta value={ledger.rows.length}>on file</CardMeta>}
        />

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search by number, ${copy.partyLabel.toLowerCase()} or job`}
              aria-label={`Search ${copy.title.toLowerCase()}`}
              className="focus-ring w-full rounded-lg border border-[var(--border)] bg-[var(--panel-solid)] py-2 pl-9 pr-3 text-sm"
            />
          </div>
          {projects.length > 0 && (
            <button
              onClick={adding ? closeAdd : openAdd}
              className="btn-accent focus-ring flex shrink-0 items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold"
            >
              <Plus className="h-[16px] w-[16px]" /> New
            </button>
          )}
        </div>

        {adding && (
          <NewDocumentForm
            copy={copy}
            projects={projects}
            suggestedNumber={suggestedNumber}
            today={today}
            form={form}
            onCancel={closeAdd}
          />
        )}

        {form.state?.ok && !adding && (
          <div className="mb-4">
            <Banner state={form.state} />
          </div>
        )}

        {/* What actually happened to the send — sent, queued, or refused
            with the reason. Never "done" for something still in a queue. */}
        {send.state && (
          <div className="mb-4">
            <Banner state={send.state} />
          </div>
        )}

        {ledger.rows.length === 0 ? (
          <p className="py-10 text-center text-sm text-faint">
            {projects.length === 0
              ? `No ${copy.one}s yet — and no jobs to raise one against. Open a deal for a client first, and it becomes a project you can quote.`
              : `No ${copy.one}s yet. Raise one against a job and it appears here and on that project.`}
          </p>
        ) : shown.length === 0 ? (
          <p className="py-10 text-center text-sm text-faint">Nothing matches &ldquo;{query}&rdquo;.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-[var(--border)]">
            {shown.map((r) => (
              <li
                key={r.id}
                className="flex flex-col gap-1 py-3 @min-[560px]:flex-row @min-[560px]:items-baseline @min-[560px]:gap-3"
              >
                <Link
                  href={`/projects/${r.projectId}?tab=documents`}
                  className="focus-ring min-w-0 flex-1 rounded"
                >
                  <p className="text-sm font-semibold">
                    {r.number}
                    <span className="ml-2 font-normal text-muted">{r.party ?? "—"}</span>
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted">
                    {r.projectTitle}
                    {r.issuedOn ? ` · ${r.issuedOn}` : ""}
                    {` · ${r.lineCount} line${r.lineCount === 1 ? "" : "s"}`}
                  </p>
                </Link>
                <p className="shrink-0 text-sm font-semibold tabular-nums @min-[560px]:w-32 @min-[560px]:text-right">
                  {money(r.totalCents)}
                </p>
                {/* The status, and whether its money is in the figures above —
                    so a reader never has to remember which statuses count. */}
                {/* Only from a state the document can leave in, and never
                    for one already gone. The action checks both again — a
                    control is tidiness, the refusal in the server is the rule. */}
                {(copy.kind === "quote" ? SENDABLE_QUOTE : SENDABLE_ORDER).includes(r.status) && !r.sentAt && (
                  <form onSubmit={send.onSubmit} className="shrink-0">
                    <input type="hidden" name="documentId" value={r.id} />
                    <button
                      type="submit"
                      disabled={send.pending}
                      className="focus-ring rounded-lg px-2.5 py-1 text-xs font-semibold text-accent disabled:opacity-60"
                      title={copy.kind === "quote" ? `Approve and email ${r.number} to the client` : `Email ${r.number} to the supplier`}
                    >
                      {send.pending ? "Sending…" : "Send"}
                    </button>
                  </form>
                )}
                <p className="shrink-0 text-xs @min-[560px]:w-36 @min-[560px]:text-right">
                  <span className="capitalize" style={{ color: STATUS_TONE[r.status] }}>
                    {statusLabel(r.status)}
                  </span>
                  {!r.counts && <span className="text-faint"> · not counted</span>}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

const field =
  "focus-ring w-full rounded-lg border border-[var(--border)] bg-[var(--panel-solid)] px-3 py-2 text-sm";

/**
 * Raising one.
 *
 * Every figure the client or the supplier will read comes from this form, so
 * it does as little arithmetic as possible: the lines go to the server as the
 * person typed them and the total is worked out there, from the same
 * expression the project screen reads back. A subtotal drawn here would be a
 * second opinion about the same number.
 */
function NewDocumentForm({
  copy,
  projects,
  suggestedNumber,
  today,
  form,
  onCancel,
}: {
  copy: LedgerCopy;
  projects: Project[];
  suggestedNumber: string;
  today: string;
  form: ReturnType<typeof useKeptForm<FormState>>;
  onCancel: () => void;
}) {
  const [lines, setLines] = useState([0]);

  return (
    <form
      {...form.formProps}
      className="mb-4 rounded-xl border border-[var(--border)] p-4"
    >
      <input type="hidden" name="kind" value={copy.kind} />

      <div className="grid grid-cols-1 gap-3 @min-[560px]:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Job</span>
          {/* Required, and not defaulted to whichever project happens to be
              first: a quotation filed against the wrong job is money on the
              wrong margin, and nothing on screen would say so. */}
          <select name="dealId" required defaultValue="" className={field} aria-label="Job">
            <option value="" disabled>
              Choose a job
            </option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
                {p.client ? ` — ${p.client}` : ""}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Number</span>
          {/* Suggested, not imposed. Plenty of businesses carry a number from
              their accounts package, and a repeat is refused by the database
              anyway — this only saves the wasted typing. */}
          <input name="number" defaultValue={suggestedNumber} required maxLength={40} className={field} />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">{copy.partyLabel}</span>
          <input
            name="party"
            maxLength={120}
            placeholder={copy.kind === "quote" ? "Who it is for" : "Who it is to"}
            className={field}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">
            {copy.kind === "quote" ? "Email (optional)" : "Supplier email"}
          </span>
          {/* A quotation reaches the job's client through the contact the
              job already has, so this is an override — the accounts inbox
              rather than the person who signed it. A purchase order has no
              contact at all, so for one of those this is the only way it can
              ever be sent, and the placeholder says so. */}
          <input
            name="partyEmail"
            type="email"
            maxLength={200}
            placeholder={
              copy.kind === "quote"
                ? "Only if not the client's usual address"
                : "Where to send the order"
            }
            className={field}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Date</span>
          <input type="date" name="issuedOn" defaultValue={today} className={field} />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Status</span>
          <select name="status" defaultValue="draft" className={field} aria-label="Status">
            {CREATE_STATUSES.map((s) => (
              <option key={s} value={s} className="capitalize">
                {statusLabel(s)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-faint">Lines</p>
      <div className="flex flex-col gap-2">
        {lines.map((key) => (
          <div key={key} className="grid grid-cols-1 gap-2 @min-[560px]:grid-cols-[1fr_90px_120px]">
            <input
              name="lineDescription"
              placeholder="What it is for"
              maxLength={200}
              className={field}
              aria-label="Description"
            />
            {/* Decimals allowed on BOTH, and the server keeps them: three
                places on a quantity to match the column, two on a price. Half
                a day is a real line, and 12,000.50 is a real rate. */}
            <input
              name="lineQuantity"
              type="text"
              inputMode="decimal"
              defaultValue="1"
              placeholder="Qty"
              className={field}
              aria-label="Quantity"
            />
            <input
              name="lineUnit"
              type="text"
              inputMode="decimal"
              placeholder="Unit price"
              className={field}
              aria-label="Unit price"
            />
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={() => setLines((l) => [...l, (l[l.length - 1] ?? 0) + 1])}
        /* A finger needs something to land on. As a bare text link this was
           16px tall — fine for a mouse, and on a phone the difference between
           adding a line and pressing whatever is underneath it. The padding is
           the target; it still reads as a link. */
        className="focus-ring mt-1 inline-flex min-h-[44px] items-center text-xs font-semibold text-accent"
      >
        + Add a line
      </button>

      <label className="mt-3 flex flex-col gap-1">
        <span className="text-xs text-muted">Notes</span>
        <textarea name="notes" rows={2} maxLength={1000} className={field} />
      </label>

      {form.state && (
        <div className="mt-3">
          <Banner state={form.state} />
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="submit"
          disabled={form.pending}
          className={clsx(
            "btn-accent focus-ring rounded-xl px-4 py-2 text-sm font-semibold",
            form.pending && "opacity-60"
          )}
        >
          {form.pending ? "Saving…" : `Save ${copy.one}`}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="focus-ring rounded-xl px-3 py-2 text-sm text-muted"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
