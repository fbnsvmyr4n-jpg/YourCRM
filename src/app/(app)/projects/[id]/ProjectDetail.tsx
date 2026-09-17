"use client";

import { useActionState, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Building2,
  CalendarDays,
  ChevronDown,
  FileText,
  GanttChartSquare,
  Mail,
  MapPin,
  Phone,
  Plus,
  Receipt,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Banner } from "@/components/ui/Banner";
import { Card, CardHeader, CardMeta } from "@/components/ui/Card";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { stageMeta } from "@/data/pipeline";
import { clsx } from "@/lib/clsx";
import { useFormDisclosure } from "@/lib/form-disclosure";
import { useMoney } from "@/components/money/CurrencyProvider";
import { CustomFieldInputs } from "@/components/custom-fields/CustomFieldInputs";
import { displayValue, type CustomField, type FieldValues } from "@/server/custom-field-rules";
import { useRememberedToggle } from "@/lib/remembered-toggle";
import type {
  DocumentLine,
  ProjectDocument,
  ProjectEvent,
  ProjectHeader,
  ProjectPerson,
  ProjectThread,
} from "@/server/repos/projects";
import type { Dependency, ProjectTask, ScheduleSummary } from "@/server/repos/tasks";
import { ProjectSchedule } from "./ProjectSchedule";
import { RetainerCard } from "./RetainerCard";
import { PayLinkButton, PaymentsReady } from "./PayLinkButton";
import type { Retainer } from "@/server/retainer-rules";
import {
  documentsByStage,
  projectMoney,
  stageMoney,
  type DocumentsByStage,
  type ProjectMoney,
  type StageEntry,
} from "@/server/stage-money";
import {
  addProjectPersonAction,
  createDocumentAction,
  fileLineAction,
  raiseInvoiceAction,
  sendInvoiceAction,
  removeProjectPersonAction,
  setDocumentStatusAction,
  updateProjectAction,
  type FormState,
} from "../actions";

/**
 * One project, as a place to work rather than a record to read.
 *
 * The list page says what the work is. This says who is on it, what has been
 * said, what has been quoted, what has been committed to spend, and what
 * happened when — which is the difference between a CRM entry and somewhere a
 * site manager can actually stand.
 *
 * Four areas behind tabs rather than one long scroll, for the reason that
 * governs every screen here: a busy job is a dozen people, forty emails and six
 * documents, and stacking them makes a page nobody reads to the bottom of. The
 * header and the money never move, because those are the two things you check
 * every time regardless of why you opened it.
 */

/**
 * Money, with the cents only when there are any.
 *
 * It was `Math.round(cents / 100)`, which reads well on a project value and
 * lies on a quotation line: a rate of $1,250.50 rendered as $1,251, so a line
 * showed "2 × $1,251 = $2,501" — arithmetic that does not work, on a document
 * somebody signs. Found by opening the screen with a real quote on it, not by a
 * test; every figure involved was correct in the database and correct in the
 * total, and only the unit price was repainted.
 *
 * Whole amounts keep their old appearance, so nothing else on this page moves.
 */
function useExactMoney() {
  const { format } = useMoney();
  return (cents: number) => format(cents, "exact");
}

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase() || "?";

/** A YYYY-MM-DD rendered as a day. Never parsed into a Date — see the repo. */
function readableDay(iso: string | null): string | null {
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map(Number);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

const DOC_STATUS_TONE: Record<string, { color: string; soft: string }> = {
  draft: { color: "var(--text-muted)", soft: "var(--raise)" },
  awaiting_approval: { color: "var(--amber)", soft: "var(--amber-soft)" },
  approved: { color: "var(--accent)", soft: "var(--accent-soft)" },
  sent: { color: "var(--accent)", soft: "var(--accent-soft)" },
  accepted: { color: "var(--green)", soft: "var(--green-soft)" },
  paid: { color: "var(--green)", soft: "var(--green-soft)" },
  declined: { color: "var(--red)", soft: "var(--red-soft)" },
  cancelled: { color: "var(--red)", soft: "var(--red-soft)" },
};

/**
 * The two statuses a person does not set from this screen.
 *
 * A quotation an agent drafted is approved in Chat, where the lines and the
 * recipient are in front of whoever is deciding. This screen's status control
 * offers six values and not these two — so before this list existed, an
 * awaiting-approval quote rendered with its select defaulted to "draft" (no
 * option matched) and one press of Update silently threw the pending approval
 * away. Found by opening the project screen, not by a type error: every one of
 * those values is a string.
 */
const AGENT_STATUSES = ["awaiting_approval", "approved"];

/** "awaiting_approval" is a column value, not something to show a person. */
const statusLabel = (status: string) => status.replace(/_/g, " ");

const EVENT_ICON = { email: Mail, meeting: Users, call: Phone, note: FileText, document: Receipt };

/** Somebody who could be put on the job: a colleague, or any contact. */
type Candidate = { id: string; name: string; company?: string | null; isClient?: boolean };

/*
   "Timeline" is the PLAN; "History" is what has already happened.

   The activity feed was called Timeline, and it is not one — it is a record of
   emails, meetings and documents after the fact, which is a history. A timeline
   is what a person means when they ask when the work happens: tasks, dates and
   how far along each one is. Naming the feed History frees the word for the
   thing it describes, and the feed's own heading already said "Everything that
   has happened".
*/
const TABS = [
  { id: "team", label: "Team", icon: Users },
  { id: "timeline", label: "Timeline", icon: GanttChartSquare },
  { id: "documents", label: "Documents", icon: Receipt },
  { id: "threads", label: "Emails", icon: Mail },
  { id: "history", label: "History", icon: CalendarDays },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function ProjectDetail({
  header,
  customFields,
  customValues,
  people,
  documents,
  retainers = [],
  paymentsReady = false,
  priceItems,
  threads,
  timeline,
  tasks,
  dependencies,
  scheduleSummary,
  today,
  candidates,
}: {
  header: ProjectHeader;
  /** This workspace's live custom fields for deals, and this job's values. */
  customFields: CustomField[];
  customValues: FieldValues;
  people: ProjectPerson[];
  documents: ProjectDocument[];
  /** Scheduled billing on this job. */
  retainers?: Retainer[];
  /** Paystack connected, in a currency it takes: invoices get a pay link. */
  paymentsReady?: boolean;
  /** The active price list, so a hand-typed line can pick a rate. */
  priceItems: { id: string; name: string; unit: string; unitCents: number }[];
  threads: ProjectThread[];
  timeline: ProjectEvent[];
  tasks: ProjectTask[];
  dependencies: { taskId: string; links: Dependency[] }[];
  scheduleSummary: ScheduleSummary;
  /** The business's own today, resolved on the server against its time zone. */
  today: string;
  candidates: { staff: Candidate[]; contacts: Candidate[] };
}) {
  const [tab, setTab] = useState<TabId>("team");
  const stage = stageMeta(header.stage);

  /*
     The money questions, answered from the documents rather than from a stored
     figure, so they cannot go stale — and through the same rules the per-stage
     figures use. This used to carry its own inline copy of "which quotes and
     orders count", which is how a screen ends up with two definitions of
     committed.
  */
  const figures = projectMoney(documents);

  const unread = threads.reduce((n, t) => n + t.unread, 0);

  return (
    <div className="mx-auto max-w-[1080px] animate-fade-up">
      <Link
        href="/projects"
        className="focus-ring mb-3 inline-flex items-center gap-1.5 rounded-lg text-xs font-medium text-muted transition-colors hover:text-accent"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        All projects
      </Link>

      <ProjectHeaderCard header={header} stage={stage} customFields={customFields} customValues={customValues} />

      <MoneyStrip value={header.valueCents} figures={figures} />

      {/* A grid, not a wrapping row: labels of different lengths let the width
          decide where the breaks fall, which is how a tab row ends up ragged on
          one device and fine on another.

          Three across on a phone since Timeline made five. Five columns at
          375px gives each tab 71px for an 18px icon and a word beside it, and
          "Documents" does not fit — it truncates to "Docum…", which reads as a
          bug rather than as a tab. Two rows of a readable label beats one row
          of five unreadable ones. */}
      <div className="mt-4 grid grid-cols-3 gap-1.5 @min-[560px]:grid-cols-5">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-pressed={active}
              className={clsx(
                "focus-ring flex flex-col items-center gap-1.5 rounded-xl px-1.5 py-2.5 text-[11px] font-semibold transition-colors @min-[560px]:flex-row @min-[560px]:justify-center @min-[560px]:gap-2 @min-[560px]:text-xs",
                active ? "text-accent" : "btn-soft text-muted"
              )}
              style={active ? { background: "var(--accent-soft)" } : undefined}
            >
              <Icon className="h-[18px] w-[18px] shrink-0" />
              <span className="w-full truncate text-center">{t.label}</span>
              {t.id === "threads" && unread > 0 && (
                <span
                  className="rounded-full px-1.5 text-[10px] font-bold"
                  style={{ background: "var(--red)", color: "#fff" }}
                >
                  {unread}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="mt-4 flex flex-col gap-4">
        {tab === "team" && <TeamTab dealId={header.id} people={people} candidates={candidates} />}
        {tab === "documents" && (
          <PaymentsReady.Provider value={paymentsReady}>
            <RetainerCard dealId={header.id} retainers={retainers} today={today} />
            <DocumentsTab dealId={header.id} documents={documents} priceItems={priceItems} tasks={tasks} />
          </PaymentsReady.Provider>
        )}
        {tab === "threads" && <ThreadsTab threads={threads} />}
        {tab === "timeline" && (
          <ProjectSchedule
            dealId={header.id}
            tasks={tasks}
            dependencies={dependencies}
            summary={scheduleSummary}
            today={today}
            staff={candidates.staff}
            /* Derived here, from the documents this page already loaded, so a
               stage's margin and the header's cannot disagree. */
            money={stageMoney(documents)}
            documents={documents}
          />
        )}
        {tab === "history" && <TimelineTab events={timeline} />}
      </div>
    </div>
  );
}

/* ---------------- header ---------------- */

function ProjectHeaderCard({
  header,
  stage,
  customFields,
  customValues,
}: {
  header: ProjectHeader;
  stage: { label: string; color: string };
  customFields: CustomField[];
  customValues: FieldValues;
}) {
  /* Only the ones filled in, beside the owner and dates — the same rule those
     follow. "Capacity —" is a line spent saying nothing; Edit details is where
     the empty ones are. */
  const filled = customFields.filter((f) => customValues[f.id] !== undefined);
  const hasDetails = Boolean(header.site || header.startsOn || header.dueOn || filled.length);
  const [state, action, pending] = useActionState<FormState, FormData>(
    updateProjectAction,
    undefined
  );
  const [editing, openEdit, closeEdit] = useFormDisclosure(state, (s) => Boolean(s?.ok));

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{header.title}</h1>
          {/* Client and site on one line — "Heineken · Stellenbosch" is how the
              job is actually named out loud. */}
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
            {header.companyName && (
              <span className="flex items-center gap-1.5">
                <Building2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
                {header.companyName}
              </span>
            )}
            {header.site && (
              <span className="flex items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden />
                {header.site}
              </span>
            )}
          </p>
        </div>
        <span
          className="shrink-0 rounded-full px-3 py-1 text-xs font-semibold"
          style={{
            background: `color-mix(in srgb, ${stage.color} 14%, transparent)`,
            color: stage.color,
          }}
        >
          {stage.label}
        </span>
      </div>

      {!editing && (
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-faint">
          <span>
            Owner{" "}
            <span className="font-medium text-[var(--text)]">
              {header.ownerName ?? "unassigned"}
            </span>
          </span>
          {/* Dates only when set. "Due —" is a line spent on an em dash; the
              button below is how you fill them in. */}
          {header.startsOn && (
            <span>
              Starts <span className="font-medium text-[var(--text)]">{readableDay(header.startsOn)}</span>
            </span>
          )}
          {header.dueOn && (
            <span>
              Due <span className="font-medium text-[var(--text)]">{readableDay(header.dueOn)}</span>
            </span>
          )}
          {filled.map((field) => (
            <span key={field.id}>
              {field.label}{" "}
              <span className="font-medium text-[var(--text)]">
                {displayValue(field.kind, customValues[field.id])}
              </span>
            </span>
          ))}
          <button
            type="button"
            onClick={openEdit}
            className="focus-ring rounded-lg font-medium text-accent transition-opacity hover:opacity-80"
          >
            {hasDetails ? "Edit details" : customFields.length ? "Add details" : "Add site and dates"}
          </button>
        </div>
      )}

      {!editing && state && (
        <div className="mt-3">
          <Banner state={state} />
        </div>
      )}

      {editing && (
        <form action={action} className="mt-4 space-y-3 border-t border-[var(--border)] pt-4">
          <Banner state={state} />
          <input type="hidden" name="dealId" value={header.id} />
          <div className="grid grid-cols-1 gap-3 @min-[560px]:grid-cols-3">
            <Field label="Site" name="site" defaultValue={header.site ?? ""} placeholder="Stellenbosch" />
            <Field label="Starts" name="startsOn" type="date" defaultValue={header.startsOn ?? ""} />
            <Field label="Due" name="dueOn" type="date" defaultValue={header.dueOn ?? ""} />
            <CustomFieldInputs fields={customFields} values={customValues} />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={closeEdit} className="btn-soft focus-ring rounded-xl px-4 py-2 text-xs font-medium text-muted">
              Cancel
            </button>
            <button type="submit" disabled={pending} className="btn-accent focus-ring rounded-xl px-4 py-2 text-xs font-semibold disabled:opacity-60">
              {pending ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      )}
    </Card>
  );
}

/**
 * Value, quoted, committed, the margin between the last two — and what has been
 * billed and received.
 *
 * Margin is shown only once there is something to compare. A margin of "$0"
 * against a job with no purchase orders yet is not a fact about the job, it is
 * a fact about the data being incomplete, and putting it on screen invites
 * somebody to act on it.
 *
 * Invoiced follows the same idea from the other side: it appears once there is
 * something to bill or something billed. On a job with nothing agreed, "$0
 * invoiced" is noise; on a job with an accepted quote it is the fact somebody
 * needs — nothing has been asked for yet.
 */
function MoneyStrip({ value, figures }: { value: number; figures: ProjectMoney }) {
  const money = useExactMoney();
  const {
    quotedCents: quoted,
    committedCents: committed,
    marginCents: margin,
    invoicedCents: invoiced,
    paidCents: paid,
    outstandingCents: outstanding,
  } = figures;
  /*
     Full figures, not the compact ones used everywhere else.

     Measured on the real fixture: £1,350,000 quoted and £600,000 committed
     rendered as "$1.4M" and "$600K" beside a margin of "$750K" — three true
     numbers that visibly do not subtract. Rounding is fine where a figure is an
     impression; it is not fine in a row somebody reads across, and these are
     the numbers a customer checks against their own accounts.
  */
  const cells: { label: string; value: string; tone?: string; note?: string }[] = [
    { label: "Project value", value: money(value) },
    { label: "Quoted & accepted", value: money(quoted), tone: quoted > 0 ? "var(--green)" : undefined },
    { label: "Committed", value: money(committed), tone: committed > 0 ? "var(--amber)" : undefined },
  ];
  if (margin !== null) {
    cells.push({
      label: "Margin",
      value: money(margin),
      tone: margin >= 0 ? "var(--green)" : "var(--red)",
    });
  }
  if (quoted > 0 || invoiced > 0) {
    cells.push({
      label: "Invoiced",
      value: money(invoiced),
      /* The two figures a business chases, in one line under the total. Stated
         as words for the two ends of the range, because "$0 paid · $0 due"
         reads like a calculation rather than an answer. */
      note:
        invoiced === 0
          ? "Nothing billed yet"
          : outstanding === 0
            ? "Paid in full"
            : `${money(paid)} paid · ${money(outstanding)} due`,
      tone: invoiced > 0 && outstanding === 0 ? "var(--green)" : undefined,
    });
  }

  /* Four cells keep the grid this strip always had, so a project with nothing
     billed looks exactly as it did. A fifth goes full width on narrow screens
     rather than leaving a hole beside it, and joins the row once there is room
     for five figures side by side. */
  const five = cells.length === 5;

  return (
    <div
      className={clsx(
        "mt-3 grid grid-cols-2 gap-2",
        five ? "@min-[820px]:grid-cols-5" : "@min-[560px]:grid-cols-4"
      )}
    >
      {cells.map((c, i) => (
        <div
          key={c.label}
          className={clsx("card min-w-0 px-3.5 py-3", five && i === 4 && "col-span-2 @min-[820px]:col-span-1")}
        >
          <p className="text-[11px] uppercase tracking-[0.1em] text-faint">{c.label}</p>
          <p
            className="mt-1 text-base font-bold tabular-nums @min-[560px]:text-lg"
            style={c.tone ? { color: c.tone } : undefined}
          >
            {c.value}
          </p>
          {c.note && <p className="mt-0.5 truncate text-xs tabular-nums text-muted">{c.note}</p>}
        </div>
      ))}
    </div>
  );
}

/* ---------------- team ---------------- */

function TeamTab({
  dealId,
  people,
  candidates,
}: {
  dealId: string;
  people: ProjectPerson[];
  candidates: { staff: Candidate[]; contacts: Candidate[] };
}) {
  const [addState, add, adding] = useActionState<FormState, FormData>(
    addProjectPersonAction,
    undefined
  );
  const [removeState, remove, removing] = useActionState<FormState, FormData>(
    removeProjectPersonAction,
    undefined
  );
  const [open, openAdd, closeAdd] = useFormDisclosure(addState, (s) => Boolean(s?.ok));

  const ours = people.filter((p) => p.side === "us");
  const theirs = people.filter((p) => p.side === "client");
  /* Somebody already on the job is not offered again. The unique index refuses
     it anyway; offering it would just be a control that fails. */
  const onJob = new Set(people.map((p) => p.personId));

  return (
    <>
      <Card>
        <CardHeader
          title="On this job"
          icon={<Users className="h-[18px] w-[18px] text-accent" />}
          action={
            !open && (
              <button
                type="button"
                onClick={openAdd}
                className="btn-accent focus-ring flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-semibold"
              >
                <UserPlus className="h-3.5 w-3.5" />
                Add
              </button>
            )
          }
        />

        <div className="flex flex-col gap-2 empty:hidden">
          <Banner state={removeState} />
          {!open && <Banner state={addState} />}
        </div>

        {open && (
          <form action={add} className="mb-4 space-y-3">
            <Banner state={addState} />
            <input type="hidden" name="dealId" value={dealId} />
            <div className="grid grid-cols-1 gap-3 @min-[440px]:grid-cols-2">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-muted">Who</span>
                <select name="person" required className="field-input" defaultValue="">
                  <option value="" disabled>
                    Choose somebody
                  </option>
                  {/* One list, both sides, grouped — so it is one decision
                      rather than two lists and a choice about which to open. */}
                  <optgroup label="Your team">
                    {candidates.staff
                      .filter((s) => !onJob.has(s.id))
                      .map((s) => (
                        <option key={s.id} value={`us:${s.id}`}>
                          {s.name}
                        </option>
                      ))}
                  </optgroup>
                  {/* "Contacts", not "Client side" — a subcontractor's
                      engineer is on the job and does not work for the client.
                      Each carries their company so two people called Dave are
                      distinguishable, and the client's own sort first. */}
                  <optgroup label="Contacts">
                    {candidates.contacts
                      .filter((c) => !onJob.has(c.id))
                      .map((c) => (
                        <option key={c.id} value={`client:${c.id}`}>
                          {c.name}
                          {c.company ? ` — ${c.company}` : ""}
                        </option>
                      ))}
                  </optgroup>
                </select>
              </label>
              <Field label="Role on this job" name="roleOnJob" placeholder="Site Manager" />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={closeAdd} className="btn-soft focus-ring rounded-xl px-4 py-2 text-xs font-medium text-muted">
                Cancel
              </button>
              <button type="submit" disabled={adding} className="btn-accent focus-ring rounded-xl px-4 py-2 text-xs font-semibold disabled:opacity-60">
                {adding ? "Adding…" : "Add to project"}
              </button>
            </div>
          </form>
        )}

        {people.length === 0 ? (
          <p className="text-xs text-faint">
            Nobody is on this job yet. Add your people and the client&apos;s, and their emails and
            meetings gather here.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <PeopleGroup label="Your team" people={ours} onRemove={remove} busy={removing} />
            <PeopleGroup label="Client side" people={theirs} onRemove={remove} busy={removing} />
          </div>
        )}
      </Card>
    </>
  );
}

function PeopleGroup({
  label,
  people,
  onRemove,
  busy,
}: {
  label: string;
  people: ProjectPerson[];
  onRemove: (formData: FormData) => void;
  busy: boolean;
}) {
  if (people.length === 0) return null;
  return (
    <section>
      <p className="mb-1.5 px-0.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
        {label} <span className="font-normal tracking-normal">({people.length})</span>
      </p>
      <ul className="flex flex-col gap-2">
        {people.map((p) => (
          <li
            key={p.id}
            className="flex flex-wrap items-center gap-3 rounded-xl px-3.5 py-3"
            style={{ background: "var(--surface-2)" }}
          >
            <Avatar initials={initialsOf(p.name)} color={p.side === "us" ? "blue" : "teal"} size="sm" />
            <div className="min-w-0 flex-1 leading-tight">
              <p className="truncate text-sm font-medium">{p.name}</p>
              <p className="mt-0.5 truncate text-xs text-faint">
                {p.roleOnJob ?? p.jobTitle ?? "No role set"}
              </p>
            </div>
            <span className="flex w-full items-center justify-end gap-2 @min-[440px]:w-auto">
              {p.email && (
                <a
                  href={`mailto:${p.email}`}
                  aria-label={`Email ${p.name}`}
                  className="btn-soft focus-ring rounded-lg p-2 text-muted transition-colors hover:text-accent"
                >
                  <Mail className="h-4 w-4" />
                </a>
              )}
              {p.phone && (
                <a
                  href={`tel:${p.phone.replace(/\s+/g, "")}`}
                  aria-label={`Call ${p.name}`}
                  className="btn-soft focus-ring rounded-lg p-2 text-muted transition-colors hover:text-accent"
                >
                  <Phone className="h-4 w-4" />
                </a>
              )}
              <form action={onRemove}>
                <input type="hidden" name="id" value={p.id} />
                <button
                  type="submit"
                  disabled={busy}
                  aria-label={`Take ${p.name} off this project`}
                  className="btn-soft focus-ring rounded-lg p-2 text-muted transition-colors hover:text-red disabled:opacity-60"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </form>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ---------------- documents ---------------- */

type PriceItem = { id: string; name: string; unit: string; unitCents: number };

function DocumentsTab({
  dealId,
  documents,
  priceItems,
  tasks,
}: {
  dealId: string;
  documents: ProjectDocument[];
  priceItems: PriceItem[];
  /** The job's plan, so documents can be arranged and filed by stage. */
  tasks: ProjectTask[];
}) {
  const [createState, create, creating] = useActionState<FormState, FormData>(
    createDocumentAction,
    undefined
  );
  const [statusState, setStatus, settingStatus] = useActionState<FormState, FormData>(
    setDocumentStatusAction,
    undefined
  );
  const [open, openForm, closeForm] = useFormDisclosure(createState, (s) => Boolean(s?.ok));
  const [raiseState, raise, raising] = useActionState<FormState, FormData>(
    raiseInvoiceAction,
    undefined
  );
  const [sendState, send, sending] = useActionState<FormState, FormData>(
    sendInvoiceAction,
    undefined
  );

  /* The stage a new document is being raised for, when it was opened from a
     stage rather than from New. */
  const [formStage, setFormStage] = useState<{ id: string; name: string } | null>(null);
  const formRef = useRef<HTMLDivElement>(null);

  /* By stage once the job has a plan, because that is how a job is run and
     paid for. Remembered per person: somebody who prefers the list by type
     should not have to choose it again every visit. */
  const [byStage, toggleByStage] = useRememberedToggle("project-documents:by-stage", true);
  const showStages = tasks.length > 0 && byStage;

  const quotes = documents.filter((d) => d.kind === "quote");
  const orders = documents.filter((d) => d.kind === "purchase_order");
  /* Its own group. An invoice is money coming IN and a purchase order is money
     going out; filing them together under "orders" put the two opposite
     directions of the job's cash in one list. */
  const invoices = documents.filter((d) => d.kind === "invoice");

  /* Offered only when there is something to bill and nothing billed yet.
     A button that appears when it cannot work is a button that teaches people
     to ignore buttons — and one that stays after invoicing is an invitation to
     bill the same job twice. */
  const acceptedQuote = quotes.find((d) => d.status === "accepted" || d.status === "paid");
  /* A retainer's monthly bills are not this job's invoice: they must not hide
     the offer to bill the quoted work. */
  const canInvoice = Boolean(acceptedQuote) && invoices.every((d) => d.fromRetainer);

  /* Bumped each time the form is deliberately opened, so it starts fresh then
     and only then — never when the stage is merely cleared. */
  const [formKey, setFormKey] = useState(0);
  const startNew = () => {
    setFormStage(null);
    setFormKey((k) => k + 1);
    openForm();
  };
  const raiseForStage = (task: { id: string; name: string }) => {
    setFormStage({ id: task.id, name: task.name });
    setFormKey((k) => k + 1);
    openForm();
    /* The form opens at the top of the card and the button pressed may be a
       long way below it. Without this the press appears to do nothing. Instant,
       not smooth: a smooth scroll silently does nothing when the pane is not
       painting frames. */
    requestAnimationFrame(() => formRef.current?.scrollIntoView({ block: "nearest" }));
  };
  const cancelForm = () => {
    closeForm();
    setFormStage(null);
  };

  return (
    <Card>
      <CardHeader
        title="Quotations, orders & invoices"
        icon={<Receipt className="h-[18px] w-[18px] text-accent" />}
        action={
          !open && (
            <div className="flex items-center gap-2">
              {tasks.length > 0 && (
                <div
                  role="group"
                  aria-label="Arrange documents"
                  className="flex rounded-xl p-0.5"
                  style={{ background: "var(--sunken)" }}
                >
                  {[
                    { label: "By stage", active: byStage },
                    { label: "By type", active: !byStage },
                  ].map((o) => (
                    <button
                      key={o.label}
                      type="button"
                      aria-pressed={o.active}
                      onClick={() => !o.active && toggleByStage()}
                      className={clsx(
                        "focus-ring rounded-[10px] px-2.5 py-1.5 text-xs font-medium transition-colors",
                        o.active ? "text-accent" : "text-muted"
                      )}
                      style={o.active ? { background: "var(--accent-soft)" } : undefined}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              )}
              <button
                type="button"
                onClick={startNew}
                className="btn-accent focus-ring flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-semibold"
              >
                <Plus className="h-3.5 w-3.5" />
                New
              </button>
            </div>
          )
        }
      />

      <div className="flex flex-col gap-2 empty:hidden">
        <Banner state={statusState} />
        <Banner state={raiseState} />
        <Banner state={sendState} />
        {!open && <Banner state={createState} />}
      </div>

      {open && (
        <div ref={formRef}>
          <DocumentForm
            /* A fresh form each time one is deliberately opened — from New or
               from a stage — so the type starts right for how it was opened.
               NOT keyed on the stage itself: clearing the stage mid-way must
               not throw away lines somebody has already typed. */
            key={formKey}
            dealId={dealId}
            priceItems={priceItems}
            action={create}
            pending={creating}
            state={createState}
            onCancel={cancelForm}
            stage={formStage}
            onClearStage={() => setFormStage(null)}
          />
        </div>
      )}

      {/* Billing the work, in one press.

          An invoice restates the lines the client already accepted, so raising
          one is a transition rather than a retype — and a figure re-typed is a
          figure that can drift between what was sold and what was billed. The
          offer only appears when there is an accepted quotation and nothing
          has been billed yet, so it cannot become a way to bill twice. */}
      {canInvoice && (
        <form action={raise} className="mb-3">
          <input type="hidden" name="dealId" value={dealId} />
          <button
            type="submit"
            disabled={raising}
            className="btn-accent focus-ring flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-60"
          >
            <Receipt className="h-3.5 w-3.5" />
            {raising ? "Raising…" : `Raise an invoice from ${acceptedQuote!.number}`}
          </button>
        </form>
      )}

      {documents.length === 0 && !open && (
        <p className="mb-3 text-xs text-faint">
          Nothing raised yet. A quotation goes to the client, a purchase order records what you
          have committed to spend, and an invoice bills the work once they accept. All three add
          up from their lines.
        </p>
      )}

      {showStages ? (
        <StageView
          grouped={documentsByStage(documents, tasks)}
          tasks={tasks}
          onStatus={setStatus}
          busy={settingStatus}
          onSend={send}
          sending={sending}
          onRaiseForStage={raiseForStage}
        />
      ) : (
        documents.length > 0 && (
          <div className="flex flex-col gap-4">
            <DocumentGroup label="Quotations" docs={quotes} tasks={tasks} onStatus={setStatus} busy={settingStatus} />
            <DocumentGroup
              label="Invoices"
              docs={invoices}
              tasks={tasks}
              onStatus={setStatus}
              busy={settingStatus}
              onSend={send}
              sending={sending}
            />
            <DocumentGroup label="Purchase orders" docs={orders} tasks={tasks} onStatus={setStatus} busy={settingStatus} />
          </div>
        )
      )}
    </Card>
  );
}

/**
 * Documents under the stage of the job they pay for.
 *
 * Anything not yet filed comes FIRST, in amber, because it is the part asking
 * for something: an unfiled supplier order is a cost no stage's margin counts.
 * Each stage then shows its own figures and a way to raise a purchase order for
 * it, including the stages with nothing filed yet — that is exactly where the
 * first order for a stage gets raised.
 */
function StageView({
  grouped,
  tasks,
  onStatus,
  busy,
  onSend,
  sending,
  onRaiseForStage,
}: {
  grouped: DocumentsByStage;
  tasks: ProjectTask[];
  onStatus: (formData: FormData) => void;
  busy: boolean;
  onSend: (formData: FormData) => void;
  sending: boolean;
  onRaiseForStage: (task: { id: string; name: string }) => void;
}) {
  const money = useExactMoney();
  const { stages, unfiled, retainer } = grouped;
  const unfiledLines = unfiled.reduce((n, e) => n + e.lines.length, 0);

  const rowFor = (groupKey: string, e: StageEntry) => (
    <DocumentRow
      key={`${groupKey}-${e.document.id}`}
      groupKey={groupKey}
      doc={e.document}
      lines={e.lines}
      /* Only when this group holds part of the document. A whole document
         shows its own total, exactly as it does by type. */
      shareCents={e.lines.length === e.document.lines.length ? undefined : e.totalCents}
      tasks={tasks}
      onStatus={onStatus}
      busy={busy}
      onSend={e.document.kind === "invoice" ? onSend : undefined}
      sending={sending}
    />
  );

  return (
    <div className="flex flex-col gap-4">
      {unfiled.length > 0 && (
        <section>
          <p
            className="mb-1 px-0.5 text-[11px] font-semibold uppercase tracking-[0.14em]"
            style={{ color: "var(--amber)" }}
          >
            Not filed to a stage{" "}
            <span className="font-normal tracking-normal">
              ({unfiledLines} {unfiledLines === 1 ? "line" : "lines"})
            </span>
          </p>
          <p className="mb-2 px-0.5 text-xs text-faint">
            Open a document and choose a stage for each line, so that stage&apos;s margin counts it.
          </p>
          <ul className="flex flex-col gap-2">{unfiled.map((e) => rowFor("unfiled", e))}</ul>
        </section>
      )}

      {retainer.length > 0 && (
        <section>
          <p className="mb-2 px-0.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
            Retainer invoices <span className="font-normal tracking-normal">({retainer.length})</span>
          </p>
          <ul className="flex flex-col gap-2">{retainer.map((e) => rowFor("retainer", e))}</ul>
        </section>
      )}

      {stages.map(({ task, entries, money: figures }) => (
        <section key={task.id}>
          <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 px-0.5">
            <p className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
              {task.name}
            </p>
            {figures && figures.quotedCents > 0 && (
              <span className="text-[11px] text-muted">
                Quoted{" "}
                <span className="font-semibold tabular-nums text-[var(--text)]">{money(figures.quotedCents)}</span>
              </span>
            )}
            {figures && figures.committedCents > 0 && (
              <span className="text-[11px] text-muted">
                Committed{" "}
                <span className="font-semibold tabular-nums text-[var(--text)]">{money(figures.committedCents)}</span>
              </span>
            )}
            {figures && figures.quotedCents > 0 && figures.committedCents > 0 && (
              <span
                className="text-[11px] font-semibold tabular-nums"
                style={{ color: figures.marginCents < 0 ? "var(--red)" : "var(--green)" }}
              >
                {figures.marginCents < 0 ? "" : "+"}
                {money(figures.marginCents)}
              </span>
            )}
            <button
              type="button"
              onClick={() => onRaiseForStage(task)}
              aria-label={`Raise a purchase order for ${task.name}`}
              className="btn-soft focus-ring flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium"
            >
              <Plus className="h-3 w-3" />
              Purchase order
            </button>
          </div>
          {entries.length === 0 ? (
            <p className="px-0.5 text-xs text-faint">Nothing filed to this stage yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">{entries.map((e) => rowFor(task.id, e))}</ul>
          )}
        </section>
      ))}
    </div>
  );
}

function DocumentGroup({
  label,
  docs,
  tasks,
  onStatus,
  busy,
  onSend,
  sending,
}: {
  label: string;
  docs: ProjectDocument[];
  tasks: ProjectTask[];
  onStatus: (formData: FormData) => void;
  busy: boolean;
  /** Only invoices can be sent from here, so only they are given this. */
  onSend?: (formData: FormData) => void;
  sending?: boolean;
}) {
  if (docs.length === 0) return null;
  return (
    <section>
      <p className="mb-1.5 px-0.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
        {label} <span className="font-normal tracking-normal">({docs.length})</span>
      </p>
      <ul className="flex flex-col gap-2">
        {docs.map((d) => (
          <DocumentRow
            key={d.id}
            groupKey={label}
            doc={d}
            tasks={tasks}
            onStatus={onStatus}
            busy={busy}
            onSend={onSend}
            sending={sending}
          />
        ))}
      </ul>
    </section>
  );
}

function DocumentRow({
  doc,
  groupKey,
  lines,
  shareCents,
  tasks,
  onStatus,
  busy,
  onSend,
  sending,
}: {
  doc: ProjectDocument;
  /** The group this row sits in. The same document can appear under several
   *  stages, and ids on the page must still be unique. */
  groupKey?: string;
  /** The lines to show, when this row holds only part of the document. */
  lines?: DocumentLine[];
  /** This group's share of the total, when it holds only part of the document. */
  shareCents?: number;
  /** The job's stages, for filing each line. */
  tasks?: ProjectTask[];
  onStatus: (formData: FormData) => void;
  busy: boolean;
  onSend?: (formData: FormData) => void;
  sending?: boolean;
}) {
  const money = useExactMoney();
  const [open, setOpen] = useState(false);
  const tone = DOC_STATUS_TONE[doc.status] ?? DOC_STATUS_TONE.draft;
  const scope = groupKey ? `${groupKey}-${doc.id}`.replace(/[^A-Za-z0-9_-]/g, "_") : doc.id;
  const linesId = `lines-${scope}`;
  const shown = lines ?? doc.lines;
  const lineCount =
    lines && lines.length !== doc.lines.length
      ? `${lines.length} of ${doc.lines.length} lines here`
      : `${doc.lines.length} ${doc.lines.length === 1 ? "line" : "lines"}`;

  return (
    <li className="overflow-hidden rounded-xl" style={{ background: "var(--surface-2)" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={linesId}
        className="focus-ring flex w-full flex-wrap items-center gap-3 px-3.5 py-3 text-left"
      >
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-sm font-medium">{doc.number}</span>
          <span className="mt-0.5 block truncate text-xs text-faint">
            {[doc.party, readableDay(doc.issuedOn), lineCount].filter(Boolean).join(" · ")}
          </span>
        </span>
        <span className="flex w-full items-center justify-end gap-2 @min-[440px]:w-auto">
          <span className="shrink-0 text-sm font-semibold tabular-nums">
            {money(shareCents ?? doc.totalCents)}
            {/* A partial figure beside a document number reads as the whole
                document unless it says otherwise. */}
            {/* A real space, not only margin: margin is invisible to a screen
                reader, which read the two figures as one ("$1,100,000of"). */}
            {shareCents !== undefined && (
              <>
                {" "}
                <span className="text-xs font-normal text-faint">of {money(doc.totalCents)}</span>
              </>
            )}
          </span>
          <span
            className="shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold capitalize"
            style={{ background: tone.soft, color: tone.color }}
          >
            {statusLabel(doc.status)}
          </span>
          <ChevronDown className={clsx("h-4 w-4 shrink-0 text-muted transition-transform", open && "rotate-180")} aria-hidden />
        </span>
      </button>

      {open && (
        <div id={linesId} className="border-t border-[var(--border)] px-3.5 py-3">
          <ul className="flex flex-col gap-1.5">
            {shown.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span className="min-w-0 flex-1 truncate">{l.description}</span>
                {tasks && tasks.length > 0 && <LineStageSelect line={l} tasks={tasks} scope={scope} />}
                <span className="shrink-0 text-faint tabular-nums">
                  {l.quantity} × {money(l.unitCents)}
                </span>
                <span className="w-20 shrink-0 text-right font-semibold tabular-nums">
                  {money(l.totalCents)}
                </span>
              </li>
            ))}
          </ul>
          {doc.notes && <p className="mt-3 whitespace-pre-line text-xs text-muted">{doc.notes}</p>}

          {/* Sending it.

              Only invoices get this — a quotation leaves through the approval
              flow in Chat, and a purchase order is something you place with a
              supplier yourself. Pressing this IS the decision: there is no
              second approval, because the figures were approved by a person
              and accepted by the client before the invoice existed.

              It disappears once the invoice has gone, rather than staying and
              relying on the handler to refuse. A live button that does nothing
              is how somebody ends up pressing it three times wondering why. */}
          {onSend && !doc.sentAt && (
            <form action={onSend} className="mt-3">
              <input type="hidden" name="documentId" value={doc.id} />
              <button
                type="submit"
                disabled={sending}
                className="btn-accent focus-ring flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-60"
              >
                <Mail className="h-3.5 w-3.5" />
                {sending ? "Sending…" : `Send ${doc.number} to ${doc.party ?? "the client"}`}
              </button>
            </form>
          )}
          {onSend && doc.sentAt && (
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
              <p className="text-xs text-faint">
                Sent {readableDay(doc.sentAt.slice(0, 10))}.{doc.status === "paid" && " Paid."}
              </p>
              {doc.status !== "paid" && doc.status !== "cancelled" && <PayLinkButton documentId={doc.id} />}
            </div>
          )}

          {/* A quotation waiting on an approval is not moved along from here:
              the decision belongs where the lines and the recipient are, and a
              select that cannot represent this document's own status would
              change it to something else the moment anybody pressed Update. */}
          {AGENT_STATUSES.includes(doc.status) ? (
            <p className="mt-3 text-right text-xs text-muted">
              {doc.status === "approved"
                ? "Approved, waiting to be sent — finish it in Chat."
                : "Waiting for approval in Chat."}
            </p>
          ) : (
          /* Moving a document along is the change actually made day to day, so
             it is one control here rather than an edit screen. */
          <form action={onStatus} className="mt-3 flex items-center justify-end gap-2">
            <input type="hidden" name="documentId" value={doc.id} />
            <label className="sr-only" htmlFor={`status-${scope}`}>
              Status for {doc.number}
            </label>
            <select
              id={`status-${scope}`}
              name="status"
              defaultValue={doc.status}
              disabled={busy}
              className="focus-ring rounded-lg px-2.5 py-1.5 text-xs font-semibold capitalize disabled:opacity-60"
              style={{ background: tone.soft, color: tone.color }}
            >
              {["draft", "sent", "accepted", "declined", "paid", "cancelled"].map((s) => (
                <option key={s} value={s} className="capitalize">
                  {s}
                </option>
              ))}
            </select>
            <button type="submit" disabled={busy} className="btn-soft focus-ring rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-60">
              Update
            </button>
          </form>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Which stage of the job a line belongs to, changed where the line is.
 *
 * The action behind this existed with nothing a person could press to reach
 * it, so the only lines ever filed were the ones the app generated itself — a
 * supplier's order typed in by hand never counted against the stage it paid
 * for. It saves on change rather than behind a button: it is one small choice,
 * and a second press to confirm it is how the choice gets forgotten.
 */
function LineStageSelect({
  line,
  tasks,
  scope,
}: {
  line: DocumentLine;
  tasks: ProjectTask[];
  scope: string;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(fileLineAction, undefined);
  const id = `stage-${scope}-${line.id}`.replace(/[^A-Za-z0-9_-]/g, "_");
  return (
    <form action={action} className="flex shrink-0 items-center gap-1.5">
      <input type="hidden" name="lineId" value={line.id} />
      <label className="sr-only" htmlFor={id}>
        Stage for {line.description}
      </label>
      <select
        id={id}
        name="projectTaskId"
        defaultValue={line.projectTaskId ?? ""}
        disabled={pending}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="focus-ring max-w-[11rem] truncate rounded-md border border-[var(--border)] bg-[var(--panel-solid)] px-1.5 py-1 text-[11px] text-muted disabled:opacity-60"
      >
        <option value="">No stage</option>
        {tasks.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      {state?.error && (
        <span role="alert" className="text-[11px]" style={{ color: "var(--red)" }}>
          {state.error}
        </span>
      )}
    </form>
  );
}

/** Four blank lines. Enough for most quotes, and blanks are dropped on save. */
const BLANK_LINES = [0, 1, 2, 3];

function DocumentForm({
  dealId,
  priceItems,
  action,
  pending,
  state,
  onCancel,
  stage,
  onClearStage,
}: {
  dealId: string;
  priceItems: PriceItem[];
  action: (formData: FormData) => void;
  pending: boolean;
  state: FormState;
  onCancel: () => void;
  /** The stage this document is being raised for, when it was opened from one. */
  stage?: { id: string; name: string } | null;
  onClearStage?: () => void;
}) {
  const money = useExactMoney();
  return (
    <form action={action} className="mb-4 space-y-3 border-b border-[var(--border)] pb-4">
      <Banner state={state} />
      <input type="hidden" name="dealId" value={dealId} />
      {stage && (
        <div
          className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl px-3 py-2 text-xs"
          style={{ background: "var(--accent-soft)" }}
        >
          <input type="hidden" name="projectTaskId" value={stage.id} />
          <span className="text-muted">For stage</span>
          <span className="font-semibold text-accent">{stage.name}</span>
          <span className="text-faint">· every line is filed there</span>
          {onClearStage && (
            <button
              type="button"
              onClick={onClearStage}
              className="focus-ring ml-auto rounded-md px-1.5 py-0.5 text-muted transition-colors hover:text-[var(--text)]"
            >
              Not for a stage
            </button>
          )}
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 @min-[560px]:grid-cols-4">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Type</span>
          <select name="kind" className="field-input" defaultValue={stage ? "purchase_order" : "quote"}>
            <option value="quote">Quotation</option>
            <option value="purchase_order">Purchase order</option>
            <option value="invoice">Invoice</option>
          </select>
        </label>
        <Field label="Number" name="number" placeholder="Q-1042" required />
        <Field label="To / from" name="party" placeholder="Heineken" />
        <Field label="Issued" name="issuedOn" type="date" />
      </div>

      <div>
        <p className="mb-1.5 text-xs font-medium text-muted">Lines</p>
        <div className="flex flex-col gap-2">
          {BLANK_LINES.map((i) => (
            <div key={i} className="grid grid-cols-[1fr_64px_88px] gap-2">
              <input
                name="lineDescription"
                placeholder={i === 0 ? "Description" : ""}
                className="field-input"
                aria-label={`Line ${i + 1} description`}
                /* The price list, offered rather than imposed. A one-off line
                   still needs to be typeable — but a line that MATCHES a price
                   item is worth much more than one that does not: it carries
                   the agreed rate, and the plan builder recovers the unit from
                   it, so "3" becomes three days rather than a one-day
                   placeholder. */
                list="price-items"
                onChange={(e) => {
                  const match = priceItems.find(
                    (p) => p.name.trim().toLowerCase() === e.target.value.trim().toLowerCase()
                  );
                  if (!match) return;
                  /* Fill the rate, and only if the person has not typed one —
                     overwriting a deliberate price with the list price would
                     silently change what a client is charged. */
                  const row = e.target.closest("div");
                  const unit = row?.querySelector<HTMLInputElement>('input[name="lineUnit"]');
                  if (unit && !unit.value) unit.value = (match.unitCents / 100).toFixed(2);
                  const qty = row?.querySelector<HTMLInputElement>('input[name="lineQuantity"]');
                  if (qty && !qty.value) qty.value = "1";
                }}
              />
              <input
                name="lineQuantity"
                type="number"
                step="0.01"
                min="0"
                placeholder="Qty"
                className="field-input"
                aria-label={`Line ${i + 1} quantity`}
              />
              <input
                name="lineUnit"
                type="number"
                step="0.01"
                min="0"
                placeholder="Unit"
                className="field-input"
                aria-label={`Line ${i + 1} unit price`}
              />
            </div>
          ))}
        </div>
        {/* One list for every row. Typing still works; picking fills the
            agreed rate so nobody retypes a number that already exists. */}
        <datalist id="price-items">
          {priceItems.map((p) => (
            <option key={p.id} value={p.name}>
              {`${money(p.unitCents)} ${p.unit}`}
            </option>
          ))}
        </datalist>
        <p className="mt-1.5 text-xs text-faint">
          {priceItems.length > 0
            ? "Start typing to pick from the price list — the rate fills itself. Leave a line blank to skip it."
            : "Leave a line blank to skip it. The total is worked out from quantity × unit price."}
        </p>
      </div>

      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-muted">Notes</span>
        <textarea name="notes" rows={2} className="field-input resize-y" />
      </label>

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn-soft focus-ring rounded-xl px-4 py-2 text-xs font-medium text-muted">
          Cancel
        </button>
        <button type="submit" disabled={pending} className="btn-accent focus-ring rounded-xl px-4 py-2 text-xs font-semibold disabled:opacity-60">
          {pending ? "Saving…" : "Save document"}
        </button>
      </div>
    </form>
  );
}

/* ---------------- threads ---------------- */

function ThreadsTab({ threads }: { threads: ProjectThread[] }) {
  return (
    <Card>
      <CardHeader
        title="Email threads"
        icon={<Mail className="h-[18px] w-[18px] text-accent" />}
        action={threads.length > 0 ? <CardMeta value={threads.length}>{threads.length === 1 ? "thread" : "threads"}</CardMeta> : undefined}
      />
      {threads.length === 0 ? (
        <p className="text-xs text-faint">
          No mail is attached to this project yet. Messages filed against it gather here as
          conversations rather than as a list.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {threads.map((t) => (
            <li key={t.id} className="rounded-xl px-3.5 py-3" style={{ background: "var(--surface-2)" }}>
              <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1 truncate text-sm font-medium">{t.subject}</p>
                {t.unread > 0 && (
                  <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: "var(--red)", color: "#fff" }}>
                    {t.unread} new
                  </span>
                )}
                <span className="shrink-0 text-xs text-faint">
                  <TimeAgo at={t.lastAt} />
                </span>
              </div>
              <p className="mt-1 truncate text-xs text-muted">{t.lastPreview}</p>
              <p className="mt-1 truncate text-xs text-faint">
                {t.messages} {t.messages === 1 ? "message" : "messages"}
                {t.participants.length > 0 && ` · ${t.participants.join(", ")}`}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ---------------- timeline ---------------- */

function TimelineTab({ events }: { events: ProjectEvent[] }) {
  const money = useExactMoney();
  return (
    <Card>
      <CardHeader title="Everything that has happened" icon={<CalendarDays className="h-[18px] w-[18px] text-accent" />} />
      {events.length === 0 ? (
        <p className="text-xs text-faint">Nothing has been recorded against this project yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {events.map((e) => {
            const Icon = EVENT_ICON[e.kind];
            return (
              <li key={e.id} className="flex gap-3">
                <span
                  className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg"
                  style={{ background: "var(--raise)", color: "var(--text-muted)" }}
                  aria-hidden
                >
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0 flex-1 leading-tight">
                  <p className="flex flex-wrap items-baseline gap-x-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{e.title}</span>
                    {e.amountCents !== null && (
                      <span className="shrink-0 text-xs font-semibold tabular-nums text-green">
                        {money(e.amountCents)}
                      </span>
                    )}
                    <span className="shrink-0 text-xs text-faint">
                      <TimeAgo at={e.at} />
                    </span>
                  </p>
                  {e.detail && (
                    <p className="mt-0.5 line-clamp-2 text-xs text-faint">{e.detail}</p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/* ---------------- bits ---------------- */

function Field({
  label,
  name,
  type = "text",
  defaultValue,
  placeholder,
  required,
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted">{label}</span>
      <input
        name={name}
        type={type}
        defaultValue={defaultValue}
        placeholder={placeholder}
        required={required}
        className="field-input"
      />
    </label>
  );
}
