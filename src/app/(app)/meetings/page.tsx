import { listMeetings } from "@/server/repos/meetings";
import { listContacts } from "@/server/repos/contacts";
import { getSettings } from "@/server/repos/settings";
import { meetingAnalytics } from "@/server/meeting-analytics";
import { decorateMeeting } from "@/server/decorate-meeting";
import { instantToWallClock } from "@/lib/zoned";
import { withTenantPage } from "@/server/tenant-session";
import MeetingsView from "./MeetingsView";

export const dynamic = "force-dynamic";

export default async function MeetingsPage() {
  const { meetings, analytics, today, addressBook } = await withTenantPage(async (q) => {
    const settings = await getSettings(q);
    const rows = await listMeetings(q);
    const contacts = await listContacts(q);
    const people = contacts.map((c) => ({
      id: c.id,
      name: `${c.firstName} ${c.lastName}`.trim(),
      email: c.email,
      info: c.info,
    }));

    // "Today" is today in the BUSINESS's zone, not the server's. Otherwise a
    // meeting booked this evening reads as tomorrow's to anyone east of the
    // machine that rendered the page.
    const nowKey =
      instantToWallClock(new Date().toISOString(), settings.timeZone)?.date ??
      new Date().toISOString().slice(0, 10);
    const [y, mo, d] = nowKey.split("-").map(Number);

    return {
      meetings: rows.map((m) => decorateMeeting(m, people, settings.timeZone, nowKey)),
      analytics: await meetingAnalytics(q),
      today: { year: y, month: mo - 1, day: d },
      /**
       * Everyone this account could book, which is the CONTACT BOOK.
       *
       * This used to be derived from the meetings themselves, so the scheduler
       * only ever knew people who had already been met — the one set of people
       * you are least likely to be booking for the first time. On an account
       * with no meetings yet it was empty, which made every suggestion on the
       * form silently offer nothing: no contact, no address, no history. That
       * reads exactly like a feature that was never shipped.
       *
       * `info` is what a contact stores as its company.
       */
      addressBook: contacts.map((c) => ({
        name: `${c.firstName} ${c.lastName}`.trim(),
        company: c.info ?? "",
        email: c.email ?? "",
      })),
    };
  });

  return (
    <MeetingsView
      meetings={meetings}
      analytics={analytics}
      today={today}
      people={addressBook}
    />
  );
}
