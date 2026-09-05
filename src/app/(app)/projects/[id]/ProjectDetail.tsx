"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Building2,
  CalendarDays,
  ChevronDown,
  FileText,
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
import type {
  ProjectDocument,
  ProjectEvent,
  ProjectHeader,
  ProjectPerson,
  ProjectThread,
} from "@/server/repos/projects";
import {
  addProjectPersonAction,
  createDocumentAction,
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

const money = (cents: number) => `$${Math.round(cents / 100).toLocaleString()}`;

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
  sent: { color: "var(--accent)", soft: "var(--accent-soft)" },
  accepted: { color: "var(--green)", soft: "var(--green-soft)" },
  paid: { color: "var(--green)", soft: "var(--green-soft)" },
  declined: { color: "var(--red)", soft: "var(--red-soft)" },
  cancelled: { color: "var(--red)", soft: "var(--red-soft)" },
};

const EVENT_ICON = { email: Mail, meeting: Users, call: Phone, note: FileText, document: Receipt };

/** Somebody who could be put on the job: a colleague, or any contact. */
type Candidate = { id: string; name: string; company?: string | null; isClient?: boolean };

const TABS = [
  { id: "team", label: "Team", icon: Users },
  { id: "documents", label: "Documents", icon: Receipt },
  { id: "threads", label: "Emails", icon: Mail },
  { id: "timeline", label: "Timeline", icon: CalendarDays },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function ProjectDetail({
  header,
  people,
  documents,
  threads,
  timeline,
  candidates,
}: {
  header: ProjectHeader;
  people: ProjectPerson[];
  documents: ProjectDocument[];
  threads: ProjectThread[];
  timeline: ProjectEvent[];
  candidates: { staff: Candidate[]; contacts: Candidate[] };
}) {
  const [tab, setTab] = useState<TabId>("team");
  const stage = stageMeta(header.stage);

  /*
     The three money questions, answered from the documents rather than from a
     stored figure. Quoted is what has been put to the client and accepted;
     committed is what has been ordered from suppliers. The difference between
     them is the margin, which is the number this page exists to make visible —
     and it is derived, so it cannot go stale.
  */
  const quoted = documents
    .filter((d) => d.kind === "quote" && (d.status === "accepted" || d.status === "paid"))
    .reduce((sum, d) => sum + d.totalCents, 0);
  const committed = documents
    .filter((d) => d.kind === "purchase_order" && d.status !== "cancelled" && d.status !== "declined")
    .reduce((sum, d) => sum + d.totalCents, 0);

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

      <ProjectHeaderCard header={header} stage={stage} />

      <MoneyStrip value={header.valueCents} quoted={quoted} committed={committed} />

      {/* A grid, not a wrapping row: four labels of different lengths let the
          width decide where the breaks fall, which is how a tab row ends up
          ragged on one device and fine on another. */}
      <div className="mt-4 grid grid-cols-4 gap-1.5">
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
        {tab === "documents" && <DocumentsTab dealId={header.id} documents={documents} />}
        {tab === "threads" && <ThreadsTab threads={threads} />}
        {tab === "timeline" && <TimelineTab events={timeline} />}
      </div>
    </div>
  );
}

/* ---------------- header ---------------- */

function ProjectHeaderCard({
  header,
  stage,
}: {
  header: ProjectHeader;
  stage: { label: string; color: string };
}) {
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
          <button
            type="button"
            onClick={openEdit}
            className="focus-ring rounded-lg font-medium text-accent transition-opacity hover:opacity-80"
          >
            {header.site || header.startsOn || header.dueOn ? "Edit details" : "Add site and dates"}
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
 * Value, quoted, committed — and the margin between the last two.
 *
 * Margin is shown only once there is something to compare. A margin of "$0"
 * against a job with no purchase orders yet is not a fact about the job, it is
 * a fact about the data being incomplete, and putting it on screen invites
 * somebody to act on it.
 */
function MoneyStrip({
  value,
  quoted,
  committed,
}: {
  value: number;
  quoted: number;
  committed: number;
}) {
  const margin = quoted - committed;
  /*
     Full figures, not the compact ones used everywhere else.

     Measured on the real fixture: £1,350,000 quoted and £600,000 committed
     rendered as "$1.4M" and "$600K" beside a margin of "$750K" — three true
     numbers that visibly do not subtract. Rounding is fine where a figure is an
     impression; it is not fine in a row somebody reads across, and these are
     the numbers a customer checks against their own accounts.
  */
  const cells: { label: string; value: string; tone?: string }[] = [
    { label: "Project value", value: money(value) },
    { label: "Quoted & accepted", value: money(quoted), tone: quoted > 0 ? "var(--green)" : undefined },
    { label: "Committed", value: money(committed), tone: committed > 0 ? "var(--amber)" : undefined },
  ];
  if (quoted > 0 && committed > 0) {
    cells.push({
      label: "Margin",
      value: money(margin),
      tone: margin >= 0 ? "var(--green)" : "var(--red)",
    });
  }

  return (
    <div className="mt-3 grid grid-cols-2 gap-2 @min-[560px]:grid-cols-4">
      {cells.map((c) => (
        <div key={c.label} className="card px-3.5 py-3">
          <p className="text-[11px] uppercase tracking-[0.1em] text-faint">{c.label}</p>
          <p
            className="mt-1 text-base font-bold tabular-nums @min-[560px]:text-lg"
            style={c.tone ? { color: c.tone } : undefined}
          >
            {c.value}
          </p>
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

function DocumentsTab({ dealId, documents }: { dealId: string; documents: ProjectDocument[] }) {
  const [createState, create, creating] = useActionState<FormState, FormData>(
    createDocumentAction,
    undefined
  );
  const [statusState, setStatus, settingStatus] = useActionState<FormState, FormData>(
    setDocumentStatusAction,
    undefined
  );
  const [open, openForm, closeForm] = useFormDisclosure(createState, (s) => Boolean(s?.ok));

  const quotes = documents.filter((d) => d.kind === "quote");
  const orders = documents.filter((d) => d.kind !== "quote");

  return (
    <Card>
      <CardHeader
        title="Quotations & orders"
        icon={<Receipt className="h-[18px] w-[18px] text-accent" />}
        action={
          !open && (
            <button
              type="button"
              onClick={openForm}
              className="btn-accent focus-ring flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-semibold"
            >
              <Plus className="h-3.5 w-3.5" />
              New
            </button>
          )
        }
      />

      <div className="flex flex-col gap-2 empty:hidden">
        <Banner state={statusState} />
        {!open && <Banner state={createState} />}
      </div>

      {open && <DocumentForm dealId={dealId} action={create} pending={creating} state={createState} onCancel={closeForm} />}

      {documents.length === 0 && !open ? (
        <p className="text-xs text-faint">
          Nothing raised yet. A quotation goes to the client; a purchase order records what you
          have committed to spend. Both add up from their lines.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <DocumentGroup label="Quotations" docs={quotes} onStatus={setStatus} busy={settingStatus} />
          <DocumentGroup label="Purchase orders" docs={orders} onStatus={setStatus} busy={settingStatus} />
        </div>
      )}
    </Card>
  );
}

function DocumentGroup({
  label,
  docs,
  onStatus,
  busy,
}: {
  label: string;
  docs: ProjectDocument[];
  onStatus: (formData: FormData) => void;
  busy: boolean;
}) {
  if (docs.length === 0) return null;
  return (
    <section>
      <p className="mb-1.5 px-0.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
        {label} <span className="font-normal tracking-normal">({docs.length})</span>
      </p>
      <ul className="flex flex-col gap-2">
        {docs.map((d) => (
          <DocumentRow key={d.id} doc={d} onStatus={onStatus} busy={busy} />
        ))}
      </ul>
    </section>
  );
}

function DocumentRow({
  doc,
  onStatus,
  busy,
}: {
  doc: ProjectDocument;
  onStatus: (formData: FormData) => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const tone = DOC_STATUS_TONE[doc.status] ?? DOC_STATUS_TONE.draft;
  const linesId = `lines-${doc.id}`;

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
            {[doc.party, readableDay(doc.issuedOn), `${doc.lines.length} ${doc.lines.length === 1 ? "line" : "lines"}`]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
        <span className="flex w-full items-center justify-end gap-2 @min-[440px]:w-auto">
          <span className="shrink-0 text-sm font-semibold tabular-nums">{money(doc.totalCents)}</span>
          <span
            className="shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold capitalize"
            style={{ background: tone.soft, color: tone.color }}
          >
            {doc.status}
          </span>
          <ChevronDown className={clsx("h-4 w-4 shrink-0 text-muted transition-transform", open && "rotate-180")} aria-hidden />
        </span>
      </button>

      {open && (
        <div id={linesId} className="border-t border-[var(--border)] px-3.5 py-3">
          <ul className="flex flex-col gap-1.5">
            {doc.lines.map((l) => (
              <li key={l.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs">
                <span className="min-w-0 flex-1 truncate">{l.description}</span>
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

          {/* Moving a document along is the change actually made day to day, so
              it is one control here rather than an edit screen. */}
          <form action={onStatus} className="mt-3 flex items-center justify-end gap-2">
            <input type="hidden" name="documentId" value={doc.id} />
            <label className="sr-only" htmlFor={`status-${doc.id}`}>
              Status for {doc.number}
            </label>
            <select
              id={`status-${doc.id}`}
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
        </div>
      )}
    </li>
  );
}

/** Four blank lines. Enough for most quotes, and blanks are dropped on save. */
const BLANK_LINES = [0, 1, 2, 3];

function DocumentForm({
  dealId,
  action,
  pending,
  state,
  onCancel,
}: {
  dealId: string;
  action: (formData: FormData) => void;
  pending: boolean;
  state: FormState;
  onCancel: () => void;
}) {
  return (
    <form action={action} className="mb-4 space-y-3 border-b border-[var(--border)] pb-4">
      <Banner state={state} />
      <input type="hidden" name="dealId" value={dealId} />
      <div className="grid grid-cols-1 gap-3 @min-[560px]:grid-cols-4">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Type</span>
          <select name="kind" className="field-input" defaultValue="quote">
            <option value="quote">Quotation</option>
            <option value="purchase_order">Purchase order</option>
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
        <p className="mt-1.5 text-xs text-faint">
          Leave a line blank to skip it. The total is worked out from quantity × unit price.
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
