import type { MeetingRecord } from "./repos/meetings";
import { LOSS_REASONS, type LossReason, type MeetingOutcome, type UpcomingMeeting } from "@/data/meetings";
import { instantToWallClock } from "@/lib/zoned";
import type { AvatarColor } from "@/components/ui/Avatar";

/**
 * A stored meeting, shaped for the screen.
 *
 * The record holds an instant and a contact id. The screen wants a date, a
 * time, a name and a relative label — every one of which is derived, and three
 * of which used to be stored. The stored `when` was the sharpest example: a
 * meeting booked "Today" still said "Today" a week later, because there was no
 * date behind it to correct from.
 *
 * The date and time are rendered in the sub-account's own zone, so what
 * somebody typed is what they see back regardless of where the server runs.
 */

const AVATAR_COLORS: AvatarColor[] = ["blue", "green", "amber", "purple", "pink", "teal"];

function paletteFor(id: string): AvatarColor {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

/** Recomputed on every read, which is the entire point. */
function whenLabel(date: string, todayKey: string): UpcomingMeeting["when"] {
  const t = Date.parse(`${todayKey}T00:00:00Z`);
  const d = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(d) || !Number.isFinite(t)) return "This Week";
  const days = Math.round((d - t) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Tomorrow";
  return "This Week";
}

export function decorateMeeting(
  m: MeetingRecord,
  people: { id: string; name: string; email: string | null; info: string | null }[],
  timeZone: string,
  todayKey: string
): UpcomingMeeting {
  const person = people.find((p) => p.id === m.contactId);
  const name = person?.name ?? "";
  const parts = name.split(/\s+/).filter(Boolean);
  const when = instantToWallClock(m.scheduledAt, timeZone);

  return {
    id: m.id,
    date: when?.date,
    when: when ? whenLabel(when.date, todayKey) : "This Week",
    time: when?.time ?? "",
    initials: ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "—",
    color: paletteFor(m.id),
    name,
    company: person?.info ?? "",
    topic: m.topic,
    type: m.kind === "in_person" ? "In-Person" : "Online",
    // `status` was a second, weaker copy of the outcome that could disagree
    // with it. Derived from the one source of truth instead: a meeting with a
    // recorded outcome is settled, one without is still pending.
    status: m.outcome === "scheduled" ? "Pending" : "Confirmed",
    outcome: m.outcome === "no_show" ? "no-show" : (m.outcome as MeetingOutcome),
    // Confirmed against the allow-list rather than asserted: a reason the UI
    // has no label for would render as an empty chip and quietly drop out of
    // the loss breakdown.
    lossReason: LOSS_REASONS.find((r) => r === m.lossReason) as LossReason | undefined,
    link: m.joinUrl ?? undefined,
    email: person?.email ?? undefined,
    notes: m.notes ?? undefined,
  };
}
