/**
 * Public holidays, as dates a workspace owns rather than dates this code
 * assumes.
 *
 * The schedule already skips weekends. Holidays are the other half, and they
 * were left out on purpose the first time round: a wrong holiday list is worse
 * than none, because it moves work for a reason nobody can see. A list that is
 * merely hardcoded is wrong for every customer in another country and wrong for
 * this one the year a government moves a date — so what is stored is the
 * workspace's own list, and this module only helps FILL it.
 *
 * The generator below is South African because that is where this business
 * works. It is a starting point somebody then edits, not a fact the scheduler
 * trusts on its own: the dates go into the workspace's list, where they can be
 * removed and added to. Another country is another generator beside this one,
 * with nothing else in the system needing to change.
 */

export type Holiday = { onDate: string; name: string };

const MS_PER_DAY = 86_400_000;
const toIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const utc = (year: number, month: number, day: number) => Date.UTC(year, month - 1, day);

/**
 * Easter Sunday, by the anonymous Gregorian algorithm.
 *
 * Two of South Africa's holidays hang off it — Good Friday and Family Day — and
 * neither can be a fixed date. Verified against a calendar for 2024 to 2028
 * before it was trusted: 31 Mar 2024, 20 Apr 2025, 5 Apr 2026, 28 Mar 2027,
 * 16 Apr 2028.
 */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return toIso(utc(year, month, day));
}

/** 0 = Sunday, matching `Date.getUTCDay`. */
const weekdayOf = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

/**
 * South Africa's public holidays for a year, with the Sunday rule applied.
 *
 * The Public Holidays Act says that when a holiday falls on a **Sunday**, the
 * Monday is the holiday. Saturday is NOT moved — a detail that is easy to
 * assume the other way and would hand somebody a day off that does not exist.
 * 2026 exercises both: Women's Day falls on Sunday 9 August and is observed on
 * the Monday, while Human Rights Day falls on Saturday 21 March and stays put.
 *
 * The observed day carries the name plus "(observed)", so a person reading the
 * list can see why a Monday in August is on it.
 */
export function southAfricanHolidays(year: number): Holiday[] {
  const easter = Date.parse(`${easterSunday(year)}T00:00:00Z`);

  const base: Holiday[] = [
    { onDate: toIso(utc(year, 1, 1)), name: "New Year's Day" },
    { onDate: toIso(utc(year, 3, 21)), name: "Human Rights Day" },
    { onDate: toIso(easter - 2 * MS_PER_DAY), name: "Good Friday" },
    { onDate: toIso(easter + 1 * MS_PER_DAY), name: "Family Day" },
    { onDate: toIso(utc(year, 4, 27)), name: "Freedom Day" },
    { onDate: toIso(utc(year, 5, 1)), name: "Workers' Day" },
    { onDate: toIso(utc(year, 6, 16)), name: "Youth Day" },
    { onDate: toIso(utc(year, 8, 9)), name: "National Women's Day" },
    { onDate: toIso(utc(year, 9, 24)), name: "Heritage Day" },
    { onDate: toIso(utc(year, 12, 16)), name: "Day of Reconciliation" },
    { onDate: toIso(utc(year, 12, 25)), name: "Christmas Day" },
    { onDate: toIso(utc(year, 12, 26)), name: "Day of Goodwill" },
  ];

  const out: Holiday[] = [];
  for (const holiday of base) {
    out.push(holiday);
    if (weekdayOf(holiday.onDate) === 0) {
      out.push({
        onDate: toIso(Date.parse(`${holiday.onDate}T00:00:00Z`) + MS_PER_DAY),
        name: `${holiday.name} (observed)`,
      });
    }
  }

  /* Sorted, because this is offered to a person to read before they accept it,
     and because two holidays landing on one day — 16 December on a Sunday puts
     its observed Monday on the 17th, but Christmas never collides — should be
     obvious rather than buried. */
  return out.sort((a, b) => a.onDate.localeCompare(b.onDate));
}

/** The generators on offer. A second country is a second entry here. */
export const HOLIDAY_SETS = [
  { id: "za", label: "South Africa", generate: southAfricanHolidays },
] as const;

export type HolidaySetId = (typeof HOLIDAY_SETS)[number]["id"];
