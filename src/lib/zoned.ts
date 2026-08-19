/**
 * Wall-clock time in a named zone → a real instant.
 *
 * A booking form submits "2026-03-01" and "14:00". That is not a moment: it is
 * a moment *in some zone*, and JavaScript will silently supply the host's if
 * you do not say which. The migration rehearsal caught exactly that — identical
 * input produced 12:00 UTC on a laptop and would have produced 14:00 UTC on
 * Vercel, so the same booking landed two hours apart depending on which machine
 * handled it.
 *
 * One implementation, used by both the migration and the booking form. Two
 * copies of a conversion this fiddly is how they end up disagreeing.
 */

/** "2:00 pm", "14:00", "2:00pm" → 24-hour parts. Null when unparseable. */
export function parseWallTime(time: string): { hour: number; minute: number } | null {
  const m = time.trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (!m) return null;

  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const suffix = m[3]?.toLowerCase();

  if (suffix === "pm" && hour < 12) hour += 12;
  if (suffix === "am" && hour === 12) hour = 0;
  // A 24-hour string with a meridiem, or 25:00, is a broken input rather than
  // something to round into range.
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/**
 * Combine a date and a wall-clock time in `zone` into an ISO instant.
 *
 * Works by reading the wall-clock as if it were UTC, asking what that instant
 * looks like in the target zone, and shifting by the difference. The offset is
 * computed for that specific date, so daylight saving is handled rather than
 * assumed away.
 *
 * Returns null when the date or time cannot be parsed — never a guess.
 */
export function wallClockToInstant(date: string, time: string, zone: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) return null;
  const t = parseWallTime(time);
  if (!t) return null;

  const wall = `${date.trim()}T${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}:00`;
  const asUtc = Date.parse(`${wall}Z`);
  if (Number.isNaN(asUtc)) return null;

  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(asUtc));
  } catch {
    // An unrecognised zone is a configuration error, not something to paper
    // over by falling back to UTC and storing a time nobody meant.
    return null;
  }

  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asZone = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour") % 24,
    part("minute"),
    part("second")
  );
  return new Date(asUtc - (asZone - asUtc)).toISOString();
}

/** The other direction: an instant → the date and time a person sees. */
export function instantToWallClock(
  iso: string,
  zone: string
): { date: string; time: string } | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(at);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const hour = get("hour") === "24" ? "00" : get("hour");
    return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${hour}:${get("minute")}` };
  } catch {
    return null;
  }
}
