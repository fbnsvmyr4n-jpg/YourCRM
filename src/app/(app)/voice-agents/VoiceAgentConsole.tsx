"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  Bot,
  CalendarPlus,
  Check,
  Clock,
  PhoneCall,
  PhoneIncoming,
  Quote,
  ShieldCheck,
  Sparkles,
  Target,
  Trash2,
  Zap,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Card } from "@/components/ui/Card";
import { agentConfig, FINDING_META, OUTCOME_META, type Call } from "@/data/calls";
import { clsx } from "@/lib/clsx";
import { deleteCallAction, processCallAction, simulateCallAction } from "./actions";

function duration(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/**
 * Bring a cited transcript line into view.
 *
 * A callback ref rather than an effect: it fires exactly when the node becomes
 * the cited one, and never on an unrelated re-render. `nearest` scrolls the
 * panel the shortest distance that reveals the line, rather than yanking the
 * whole page to it.
 *
 * Deliberately instant. Smooth scrolling is driven by animation frames, which a
 * panel that is offscreen, backgrounded or mid-transition may not be producing
 * — and a jump that silently does nothing is worse than one with no animation.
 * The distance here is a few centimetres inside one card.
 */
const scrollIntoView = (node: HTMLDivElement | null) => {
  node?.scrollIntoView({ block: "nearest" });
};

/**
 * How much of what the model claimed was actually in the transcript.
 *
 * Shown, not hidden. The number exists because a model reading a phone call
 * will occasionally assert something nobody said; anything it could not
 * support was already dropped, and this says how often it tried. A reader who
 * cannot see that has no way to calibrate how much to trust the rest.
 */
function GroundingChip({ score }: { score: number }) {
  const tone = score >= 90 ? "var(--green)" : score >= 70 ? "var(--amber)" : "var(--red)";
  const soft = score >= 90 ? "var(--green-soft)" : score >= 70 ? "var(--amber-soft)" : "var(--red-soft)";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[10px] font-semibold uppercase tracking-wide tabular-nums"
      style={{ background: soft, color: tone }}
      title={
        score === 100
          ? "Every claim was traced to a line of the transcript."
          : `${100 - score}% of what the model claimed could not be found in the transcript and was discarded.`
      }
    >
      <ShieldCheck className="h-3 w-3" /> {score}% evidenced
    </span>
  );
}

type Toast = { lead: boolean; leadMatched: boolean; meeting: boolean; name: string } | null;

export function VoiceAgentConsole({
  calls,
  phoneNumber,
}: {
  calls: Call[];
  /** The connected line, or null while calls are simulated. */
  phoneNumber: string | null;
}) {
  const [selectedId, setSelectedId] = useState(calls[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast>(null);

  const selected = calls.find((c) => c.id === selectedId) ?? calls[0];

  const processed = calls.filter((c) => c.status === "processed").length;
  const booked = calls.filter((c) => c.outcome === "meeting-booked").length;
  const totalSec = calls.reduce((s, c) => s + c.durationSec, 0);

  async function handleSimulate() {
    setBusy(true);
    setToast(null);
    try {
      const res = await simulateCallAction();
      if (res.call) {
        setSelectedId(res.call.id);
        setToast({
          lead: !!res.contactCreated,
          leadMatched: !!res.contactMatched,
          meeting: !!res.meetingCreated,
          name: res.call.callerName,
        });
        setTimeout(() => setToast(null), 6000);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleProcess(id: string) {
    setBusy(true);
    try {
      const res = await processCallAction(id);
      if (res.call) {
        setToast({
          lead: !!res.contactCreated,
          leadMatched: !!res.contactMatched,
          meeting: !!res.meetingCreated,
          name: res.call.callerName,
        });
        setTimeout(() => setToast(null), 6000);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string) {
    if (
      !confirm(
        "Delete this call record? You can put it back from Settings → Recently deleted."
      )
    )
      return;
    setBusy(true);
    try {
      await deleteCallAction(id);
      const rest = calls.filter((c) => c.id !== id);
      setSelectedId(rest[0]?.id ?? "");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1500px] animate-fade-up">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 pb-5 pt-1">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Voice Agent</h1>
          <p className="mt-1 text-sm text-muted">
            {agentConfig.name} answers your calls, captures the lead, and books the meeting — automatically.
          </p>
        </div>
        <button
          onClick={handleSimulate}
          disabled={busy}
          className="btn-accent focus-ring flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-60"
        >
          <PhoneIncoming className="h-4 w-4" />
          {busy ? "Handling call…" : "Simulate incoming call"}
        </button>
      </div>

      {/* Automation result toast */}
      {toast && (
        <div
          className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border p-4"
          style={{ borderColor: "var(--green)", background: "var(--green-soft)" }}
        >
          <span className="flex items-center gap-2 text-sm font-semibold text-green">
            <Zap className="h-4 w-4" /> Automation ran for {toast.name}
          </span>
          {toast.lead && (
            <span className="flex items-center gap-1.5 text-sm text-muted">
              <Check className="h-4 w-4 text-green" /> Lead created in <strong>Leads</strong>
            </span>
          )}
          {toast.leadMatched && (
            <span className="flex items-center gap-1.5 text-sm text-muted">
              <Check className="h-4 w-4 text-green" /> Matched an existing lead — no duplicate
            </span>
          )}
          {toast.meeting && (
            <span className="flex items-center gap-1.5 text-sm text-muted">
              <Check className="h-4 w-4 text-green" /> Meeting booked in <strong>Meetings</strong>
            </span>
          )}
        </div>
      )}

      {/* Agent status + stats */}
      <div className="grid grid-cols-1 gap-4 @min-[680px]:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
        {/* The badge used to read LIVE over fixed office hours, both hardcoded.
            Nothing could be dialled and there were no hours — so it asserted a
            working phone line that did not exist. It now reports the real state
            of the telephony config: live only when a number is actually
            connected, and honest about being simulated when it isn't. */}
        <Card className="flex items-center gap-4">
          <span
            className="relative grid h-12 w-12 shrink-0 place-items-center rounded-2xl"
            style={{ background: "var(--accent-soft)" }}
          >
            <Bot className="h-6 w-6 text-accent" />
            <span
              className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-[var(--panel-solid)]"
              style={{ background: phoneNumber ? "var(--green)" : "var(--amber)" }}
            />
          </span>
          <div className="min-w-0">
            <p className="flex items-center gap-2 font-semibold">
              {agentConfig.name}
              <span
                className="rounded-full px-2 py-0.5 text-[10px] font-bold"
                style={
                  phoneNumber
                    ? { background: "var(--green-soft)", color: "var(--green)" }
                    : { background: "var(--amber-soft)", color: "var(--amber)" }
                }
              >
                {phoneNumber ? "LIVE · 24/7" : "SIMULATED"}
              </span>
            </p>
            <p className="truncate text-xs text-faint">
              {phoneNumber ? `Answering ${phoneNumber} around the clock` : "No phone number connected yet"}
            </p>
          </div>
        </Card>
        <Stat icon={<PhoneCall className="h-5 w-5" />} value={String(calls.length)} label="Calls handled" tone="var(--accent)" soft="var(--accent-soft)" />
        <Stat icon={<CalendarPlus className="h-5 w-5" />} value={String(booked)} label="Meetings booked" tone="var(--green)" soft="var(--green-soft)" />
        <Stat icon={<Clock className="h-5 w-5" />} value={duration(totalSec)} label="Talk time" tone="var(--purple)" soft="var(--purple-soft)" />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 @min-[780px]:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        {/* Call log */}
        <Card className="!p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[15px] font-semibold tracking-tight">Call Log</h2>
            <span className="text-xs text-faint">
              {processed}/{calls.length} processed
            </span>
          </div>
          {calls.length === 0 ? (
            <p className="py-10 text-center text-sm text-faint">No calls yet.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {calls.map((call) => {
                const meta = OUTCOME_META[call.outcome];
                const active = call.id === selected?.id;
                return (
                  <button
                    key={call.id}
                    onClick={() => setSelectedId(call.id)}
                    className={clsx(
                      "focus-ring rounded-2xl border p-3 text-left transition-colors",
                      active
                        ? "border-[var(--border-strong)]"
                        : "border-[var(--border)] hover:border-[var(--border-strong)]"
                    )}
                    style={active ? { background: "var(--accent-soft)" } : undefined}
                  >
                    <div className="flex items-center gap-3">
                      <Avatar initials={call.initials} color={call.color} />
                      <div className="min-w-0 flex-1 leading-tight">
                        <p className="truncate text-sm font-semibold">{call.callerName}</p>
                        <p className="truncate text-xs text-faint">{call.company}</p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-[11px] text-faint">{timeAgo(call.receivedAt)}</p>
                        <p className="text-[11px] text-faint">{duration(call.durationSec)}</p>
                      </div>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <span
                        className="rounded-md px-2 py-0.5 text-[10px] font-semibold"
                        style={{ background: meta.soft, color: meta.color }}
                      >
                        {meta.label}
                      </span>
                      {call.status === "pending" && (
                        <span className="rounded-md px-2 py-0.5 text-[10px] font-semibold text-amber" style={{ background: "var(--amber-soft)" }}>
                          NEEDS PROCESSING
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </Card>

        {/* Detail */}
        {selected ? (
          <CallDetail call={selected} busy={busy} onProcess={() => handleProcess(selected.id)} onDelete={() => handleDelete(selected.id)} />
        ) : (
          <Card className="grid place-items-center py-16 text-sm text-faint">
            Select a call to see the transcript.
          </Card>
        )}
      </div>
    </div>
  );
}

function Stat({
  icon,
  value,
  label,
  tone,
  soft,
}: {
  icon: React.ReactNode;
  value: string;
  label: string;
  tone: string;
  soft: string;
}) {
  return (
    <Card className="flex items-center gap-3">
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl" style={{ background: soft, color: tone }}>
        {icon}
      </span>
      <div className="min-w-0 leading-tight">
        <p className="truncate text-xl font-bold tabular-nums">{value}</p>
        <p className="text-[11px] text-faint">{label}</p>
      </div>
    </Card>
  );
}

function CallDetail({
  call,
  busy,
  onProcess,
  onDelete,
}: {
  call: Call;
  busy: boolean;
  onProcess: () => void;
  onDelete: () => void;
}) {
  const meta = OUTCOME_META[call.outcome];
  /*
     Which transcript turn the reader asked to see.

     Showing evidence is only worth anything if a person can check it, and
     checking means reading the line where it was said — with what came before
     and after it. So a finding is a control that reveals its own turn in the
     transcript, not a static blockquote sitting next to one.
  */
  const [shownTurn, setShownTurn] = useState<number | null>(null);
  return (
    <Card className="card-q flex flex-col">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border)] pb-4">
        <div className="flex items-center gap-3">
          <Avatar initials={call.initials} color={call.color} size="lg" />
          <div className="leading-tight">
            <p className="text-base font-semibold">{call.callerName}</p>
            <p className="text-xs text-faint">
              {call.company} · {call.phone}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="rounded-lg px-2.5 py-1 text-xs font-semibold"
            style={{ background: meta.soft, color: meta.color }}
          >
            {meta.label}
          </span>
          <button
            onClick={onDelete}
            disabled={busy}
            className="focus-ring grid h-9 w-9 place-items-center rounded-full text-faint transition-colors hover:text-[var(--red)] disabled:opacity-50"
            aria-label="Delete call"
          >
            <Trash2 className="h-[18px] w-[18px]" />
          </button>
        </div>
      </div>

      {/* Agent summary.
          This is the one thing worth reading on the whole panel — what the
          caller actually wanted — and as small grey body copy it read as a
          caption and got scanned straight past. It now carries the weight of
          the conclusion it is: accent-lit panel, a rule down the edge to anchor
          the eye, and text at reading size rather than metadata size. */}
      <div className="my-4 rounded-2xl border border-[var(--border)] p-4" style={{ background: "var(--accent-soft)" }}>
        <p className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-accent">
          <Sparkles className="h-3.5 w-3.5" /> Agent summary
        </p>
        <p className="border-l-2 pl-3 text-[15px] font-medium leading-relaxed text-[var(--text)]" style={{ borderColor: "var(--accent)" }}>
          {call.summary}
        </p>
        {(call.topic || call.analysis?.intent) && (
          <p className="mt-3 text-xs text-muted">
            <span className="font-semibold text-[var(--text)]">
              {call.topic ? "Topic:" : "Caller wanted:"}
            </span>{" "}
            {call.topic ?? call.analysis?.intent}
          </p>
        )}
      </div>

      {/* What the call established, and the line each claim rests on.

          Every finding here survived a check: its quotation was located in the
          transcript before it was stored, and anything the model asserted
          without support was dropped. `grounding` is what fraction survived —
          shown rather than hidden, because a low score is a real signal about
          the call (a bad line, a rambling caller) and a summary nobody can
          calibrate is a summary nobody should trust. */}
      {call.analysis && call.analysis.findings.length > 0 && (
        <div className="mb-4">
          <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
              What the call established
            </p>
            <GroundingChip score={call.analysis.grounding} />
          </div>
          <ul className="flex flex-col gap-2">
            {call.analysis.findings.map((f, i) => {
              const kind = FINDING_META[f.kind];
              const open = shownTurn === f.turn;
              return (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => setShownTurn(open ? null : f.turn)}
                    aria-expanded={open}
                    className={clsx(
                      "focus-ring flex w-full items-start gap-2.5 rounded-xl border p-3 text-left transition-colors",
                      open
                        ? "border-[var(--accent)] bg-[var(--raise)]"
                        : "border-[var(--border)] hover:bg-[var(--raise)]"
                    )}
                  >
                    <span
                      className="mt-px shrink-0 rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                      style={{ background: kind.soft, color: kind.color }}
                    >
                      {kind.label}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm leading-snug text-[var(--text)]">{f.detail}</span>
                      {/* The transcript's own words, not the model's tidied
                          version of them — the stored evidence is the turn
                          text itself. */}
                      <span
                        className={clsx(
                          "mt-1.5 border-l-2 pl-2.5 text-xs italic leading-snug text-muted",
                          /* `line-clamp` sets its own display; letting `block`
                             also apply leaves which one wins to stylesheet
                             order rather than intent. */
                          open ? "block" : "line-clamp-1"
                        )}
                        style={{ borderColor: kind.color }}
                      >
                        “{f.evidence}”
                      </span>
                    </span>
                    <Quote
                      className={clsx(
                        "mt-0.5 h-3.5 w-3.5 shrink-0 transition-colors",
                        open ? "text-accent" : "text-faint"
                      )}
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* What the automation produced.
          A processed call with no link means the record it created was deleted
          afterwards (the link is cleared so nothing points at a missing row) —
          say so, rather than "will be created", which will never happen now. */}
      <div className="grid grid-cols-1 gap-3 @min-[440px]:grid-cols-2">
        <AutomationCard
          icon={<Target className="h-4 w-4" />}
          title="Lead"
          done={!!call.createdLeadId}
          // "Added to Leads" was asserted whenever a lead id existed, including
          // when the caller matched a lead that was already there — so a repeat
          // caller produced a card promising a new lead the user then couldn't
          // find. Say which of the two actually happened. Rows written before
          // `leadLink` existed can't know, so they state only what is certain.
          doneText={
            call.leadLink === "created"
              ? "Added to Leads"
              : call.leadLink === "matched"
                ? "Matched an existing lead"
                : "Linked to a lead"
          }
          pendingText={
            call.outcome === "not-interested"
              ? "Not applicable"
              : call.status === "processed"
                ? "Lead was deleted"
                : "Will be created"
          }
          na={call.outcome === "not-interested"}
          href={call.createdLeadId ? "/leads" : undefined}
        />
        <AutomationCard
          icon={<CalendarPlus className="h-4 w-4" />}
          title="Meeting"
          done={!!call.createdMeetingId}
          doneText={`Booked ${call.requestedWhen ?? ""} ${call.requestedTime ?? ""}`.trim()}
          pendingText={
            call.outcome !== "meeting-booked"
              ? "None requested"
              : call.status === "processed"
                ? "Meeting was deleted"
                : "Will be booked"
          }
          na={call.outcome !== "meeting-booked"}
          href={call.createdMeetingId ? "/meetings" : undefined}
        />
      </div>

      {call.status === "pending" && (
        <button
          onClick={onProcess}
          disabled={busy}
          className="btn-accent focus-ring mt-4 flex items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-semibold disabled:opacity-60"
        >
          <Zap className="h-4 w-4" /> {busy ? "Running…" : "Run automation"}
        </button>
      )}

      {/* Transcript */}
      {call.transcript.length > 0 && (
        <div className="mt-5 border-t border-[var(--border)] pt-4">
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Transcript</p>
          <div className="flex flex-col gap-3">
            {call.transcript.map((line, i) => {
              const isAgent = line.speaker === "Agent";
              /* The turn a finding was traced to. Ringed rather than
                 recoloured, so the speaker's own colour still reads. */
              const cited = shownTurn === i;
              return (
                <div
                  key={i}
                  ref={cited ? scrollIntoView : undefined}
                  className={clsx("flex", isAgent ? "justify-start" : "justify-end")}
                >
                  <div
                    className={clsx(
                      "max-w-[80%] rounded-2xl px-3.5 py-2.5 transition-shadow",
                      cited && "ring-2 ring-[var(--accent)]"
                    )}
                    style={{
                      background: isAgent ? "var(--raise)" : "var(--accent-soft)",
                    }}
                  >
                    <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-faint">
                      {line.speaker}
                    </p>
                    <p className="text-sm leading-snug">{line.text}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}

function AutomationCard({
  icon,
  title,
  done,
  doneText,
  pendingText,
  na,
  href,
}: {
  icon: React.ReactNode;
  title: string;
  done: boolean;
  doneText: string;
  pendingText: string;
  na: boolean;
  /** Where the record lives. Given only when there is really one to open. */
  href?: string;
}) {
  const color = done ? "var(--green)" : na ? "var(--text-faint)" : "var(--amber)";
  const soft = done ? "var(--green-soft)" : na ? "var(--raise)" : "var(--amber-soft)";

  const body = (
    <>
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl" style={{ background: soft, color }}>
        {done ? <Check className="h-4 w-4" /> : icon}
      </span>
      <div className="min-w-0 leading-tight">
        <p className="text-sm font-medium">{title}</p>
        <p className="truncate text-xs" style={{ color }}>
          {done ? doneText : pendingText}
        </p>
      </div>
      {href && <ArrowUpRight className="ml-auto h-4 w-4 shrink-0 text-faint" />}
    </>
  );

  const shell = "flex items-center gap-3 rounded-2xl border border-[var(--border)] p-3";

  // A claim the user can check for themselves is worth more than one they have
  // to take on trust — the whole complaint here was a card asserting a record
  // that turned out not to be there.
  return href ? (
    <Link href={href} className={`${shell} focus-ring transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--raise)]`}>
      {body}
    </Link>
  ) : (
    <div className={shell}>{body}</div>
  );
}
