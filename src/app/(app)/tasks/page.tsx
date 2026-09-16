import { listDeals, OPEN_STAGES } from "@/server/repos/deals";
import { assignableTeam } from "@/server/repos/automations";
import { getSettings } from "@/server/repos/settings";
import { listTodos } from "@/server/repos/todos";
import { requireTenantPage, withTenantPage } from "@/server/tenant-session";
import { instantToWallClock } from "@/lib/zoned";
import { TasksView } from "./TasksView";

/* A task ticked a moment ago must be ticked on arrival. */
export const dynamic = "force-dynamic";

export default async function TasksPage() {
  const ctx = await requireTenantPage();
  const data = await withTenantPage(async (q) => {
    const settings = await getSettings(q);
    return {
      todos: await listTodos(q),
      team: await assignableTeam(q),
      /* Deals still being worked, for "what is this about". A won deal's tasks
         are filed from its project page's contact; a lost one needs none. */
      deals: (await listDeals(q))
        .filter((d) => (OPEN_STAGES as readonly string[]).includes(d.stage) || d.stage === "won" || d.stage === "delivery")
        .map((d) => ({ id: d.id, title: d.title })),
      /* The business's own day. "Due today" in Johannesburg is not the server's today. */
      today:
        instantToWallClock(new Date().toISOString(), settings.timeZone)?.date ??
        new Date().toISOString().slice(0, 10),
    };
  });

  return (
    <TasksView
      todos={data.todos}
      today={data.today}
      team={data.team}
      currentUserId={ctx.userId}
      deals={data.deals}
    />
  );
}
