import { listMeetings, meetingAnalytics } from "@/server/meetings-repo";
import { getSettings } from "@/server/settings-repo";
import MeetingsView from "./MeetingsView";

export const dynamic = "force-dynamic";

export default async function MeetingsPage() {
  const [meetings, analytics, settings] = await Promise.all([
    listMeetings(),
    meetingAnalytics(),
    getSettings(),
  ]);
  const now = new Date();
  const today = { year: now.getFullYear(), month: now.getMonth(), day: now.getDate() };
  return <MeetingsView
      meetings={meetings}
      analytics={analytics}
      capacity={settings.weeklyCapacity}
      today={today}
    />;
}
