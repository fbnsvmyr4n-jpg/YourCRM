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

/**
 * A zone's current distance from UTC, as a label: "UTC+2", "UTC-4", "UTC+5:30".
 *
 * `timeZoneName: "shortOffset"` rather than `"short"`. `short` returns whatever
 * the zone is commonly CALLED — "BST" for London, "SAST" for Johannesburg,
 * "UTC" for UTC — which is an abbreviation, not an offset, and tells a reader
 * nothing about how far from UTC they are.
 *
 * It also has to be derived rather than computed. Not every zone is a whole
 * number of hours from UTC: India is +5:30 and the Chatham Islands are +12:45,
 * so anything dividing by 3600000 rounds real places into the wrong offset. And
 * the answer moves — London is +0 in January and +1 in July — which is why an
 * instant is required rather than assumed.
 *
 * @param at the moment to measure at; DST means the answer depends on it.
 */
export function utcOffsetLabel(timeZone: string, at: Date): string | null {
  let raw: string | undefined;
  try {
    raw = new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "shortOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value;
  } catch {
    // An unknown zone throws rather than falling back, and a label is not worth
    // taking the page down for.
    return null;
  }
  if (!raw) return null;

  const named = raw.replace(/^GMT/, "UTC");
  /* UTC itself comes back as a bare "GMT" with no sign. Left alone it would be
     the one zone in the world that does not state an offset. */
  return /[+-]/.test(named) ? named : `${named}+0`;
}
