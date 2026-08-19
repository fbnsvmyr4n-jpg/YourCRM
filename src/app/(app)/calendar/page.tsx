import { listMeetings } from "@/server/repos/meetings";
import { listContacts } from "@/server/repos/contacts";
import { getSettings } from "@/server/repos/settings";
import { decorateMeeting } from "@/server/decorate-meeting";
import { instantToWallClock } from "@/lib/zoned";
import { withTenantPage } from "@/server/tenant-session";
import CalendarView from "./CalendarView";

export const dynamic = "force-dynamic";

export default async function CalendarPage() {
  const { meetings, today } = await withTenantPage(async (q) => {
    const settings = await getSettings(q);
    const rows = await listMeetings(q);
    const contacts = await listContacts(q);
    const people = contacts.map((c) => ({
      id: c.id,
      name: `${c.firstName} ${c.lastName}`.trim(),
      email: c.email,
      info: c.info,
    }));

    /**
     * "Today" in the business's zone, not the server's.
     *
     * A calendar is the one screen where this is unmissable: with the server's
     * clock, a user east of it sees the highlight land on the wrong square for
     * part of every day, and a meeting booked this evening files itself under
     * tomorrow.
     */
    const nowKey =
      instantToWallClock(new Date().toISOString(), settings.timeZone)?.date ??
      new Date().toISOString().slice(0, 10);
    const [year, month, day] = nowKey.split("-").map(Number);

    return {
      meetings: rows.map((m) => decorateMeeting(m, people, settings.timeZone, nowKey)),
      today: { year, month: month - 1, day },
    };
  });

  return <CalendarView meetings={meetings} today={today} />;
}
