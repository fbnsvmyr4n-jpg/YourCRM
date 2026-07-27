import { listMeetings } from "@/server/meetings-repo";
import CalendarView from "./CalendarView";

export const dynamic = "force-dynamic";

export default async function CalendarPage() {
  const meetings = await listMeetings();
  const now = new Date();
  return (
    <CalendarView
      meetings={meetings}
      today={{ year: now.getFullYear(), month: now.getMonth(), day: now.getDate() }}
    />
  );
}
