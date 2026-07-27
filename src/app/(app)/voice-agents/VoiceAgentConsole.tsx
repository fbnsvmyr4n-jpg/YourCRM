"use client";

import { useState } from "react";
import {
  Bot,
  CalendarPlus,
  Check,
  Clock,
  PhoneCall,
  PhoneIncoming,
  Sparkles,
  Target,
  Trash2,
  Zap,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Card } from "@/components/ui/Card";
import { agentConfig, OUTCOME_META, type Call } from "@/data/calls";
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

type Toast = { lead: boolean; leadMatched: boolean; meeting: boolean; name: string } | null;

export function VoiceAgentConsole({ calls }: { calls: Call[] }) {
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
          lead: !!res.leadCreated,
          leadMatched: !!res.leadMatched,
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
          lead: !!res.leadCreated,
          leadMatched: !!res.leadMatched,
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
    if (!confirm("Delete this call record?")) return;
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
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.3fr_1fr_1fr_1fr]">
        <Card className="flex items-center gap-4">
          <span
            className="relative grid h-12 w-12 shrink-0 place-items-center rounded-2xl"
            style={{ background: "var(--accent-soft)" }}
          >
            <Bot className="h-6 w-6 text-accent" />
            <span className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-[var(--panel-solid)] bg-[var(--green)]" />
          </span>
          <div className="min-w-0">
            <p className="flex items-center gap-2 font-semibold">
              {agentConfig.name}
              <span
                className="rounded-full px-2 py-0.5 text-[10px] font-bold"
                style={{ background: "var(--green-soft)", color: "var(--green)" }}
              >
                LIVE
              </span>
            </p>
            <p className="truncate text-xs text-faint">{agentConfig.hours}</p>
          </div>
        </Card>
        <Stat icon={<PhoneCall className="h-5 w-5" />} value={String(calls.length)} label="Calls handled" tone="var(--accent)" soft="var(--accent-soft)" />
        <Stat icon={<CalendarPlus className="h-5 w-5" />} value={String(booked)} label="Meetings booked" tone="var(--green)" soft="var(--green-soft)" />
        <Stat icon={<Clock className="h-5 w-5" />} value={duration(totalSec)} label="Talk time" tone="var(--purple)" soft="var(--purple-soft)" />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
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
  return (
    <Card className="flex flex-col">
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

      {/* Summary */}
      <div className="py-4">
        <p className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
          <Sparkles className="h-3.5 w-3.5 text-accent" /> Agent summary
        </p>
        <p className="text-sm leading-relaxed text-muted">{call.summary}</p>
      </div>

      {/* What the automation produced.
          A processed call with no link means the record it created was deleted
          afterwards (the link is cleared so nothing points at a missing row) —
          say so, rather than "will be created", which will never happen now. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <AutomationCard
          icon={<Target className="h-4 w-4" />}
          title="Lead"
          done={!!call.createdLeadId}
          doneText="Added to Leads"
          pendingText={
            call.outcome === "not-interested"
              ? "Not applicable"
              : call.status === "processed"
                ? "Lead was deleted"
                : "Will be created"
          }
          na={call.outcome === "not-interested"}
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
              return (
                <div key={i} className={clsx("flex", isAgent ? "justify-start" : "justify-end")}>
                  <div
                    className="max-w-[80%] rounded-2xl px-3.5 py-2.5"
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
}: {
  icon: React.ReactNode;
  title: string;
  done: boolean;
  doneText: string;
  pendingText: string;
  na: boolean;
}) {
  const color = done ? "var(--green)" : na ? "var(--text-faint)" : "var(--amber)";
  const soft = done ? "var(--green-soft)" : na ? "var(--raise)" : "var(--amber-soft)";
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-[var(--border)] p-3">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl" style={{ background: soft, color }}>
        {done ? <Check className="h-4 w-4" /> : icon}
      </span>
      <div className="min-w-0 leading-tight">
        <p className="text-sm font-medium">{title}</p>
        <p className="truncate text-xs" style={{ color }}>
          {done ? doneText : pendingText}
        </p>
      </div>
    </div>
  );
}
