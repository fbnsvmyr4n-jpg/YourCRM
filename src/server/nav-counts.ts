import type { TenantQuery } from "./tenant";
import { getSettings } from "./repos/settings";
import { dueForUser } from "./repos/todos";
import { instantToWallClock } from "@/lib/zoned";

/**
 * The numbers on the sidebar.
 *
 * The Inbox badge was the string `"12"`, written into the navigation config.
 * It read 12 on a database holding no messages at all, which is worse than
 * showing nothing: a badge is a claim that there is something waiting, and
 * acting on it means opening an empty screen. On a signed-in customer's first
 * day it is the first thing the product tells them, and it is false.
 *
 * Counted inside the tenant, so the badge belongs to the workspace being looked
 * at — switching client shows that client's unread, not a total across all of
 * them.
 */

export type NavCounts = {
  /** Unread received messages. Zero means the badge is not rendered at all. */
  inbox: number;
  /** Whether anything is scheduled today — the Calendar dot. */
  calendarToday: boolean;
  /**
   * The reader's OWN open tasks due today or already late. Not the team's: a
   * badge counting colleagues' work is a number nobody can clear.
   */
  tasksDue: number;
};

export async function navCounts(q: TenantQuery): Promise<NavCounts> {
  const row = await q.one<{ unread: string; today: string }>(
    `SELECT
       (SELECT count(*) FROM messages
         WHERE sub_account_id = $1
           AND deleted_at IS NULL AND unread AND direction = 'received')::text AS unread,
       (SELECT count(*) FROM meetings
         WHERE sub_account_id = $1
           AND deleted_at IS NULL
           -- Bounded by a half-open day rather than casting the column to a
           -- date, so meetings_tenant_idx (sub_account_id, scheduled_at) is
           -- still usable.
           AND scheduled_at >= date_trunc('day', now())
           AND scheduled_at <  date_trunc('day', now()) + interval '1 day')::text AS today`,
    [q.ctx.subAccountId]
  );

  /* Due "today" in the business's calendar, the same day the Tasks page uses. */
  const settings = await getSettings(q);
  const today =
    instantToWallClock(new Date().toISOString(), settings.timeZone)?.date ??
    new Date().toISOString().slice(0, 10);
  const tasks = q.ctx.userId ? await dueForUser(q, q.ctx.userId, today) : { dueToday: 0, overdue: 0 };

  return {
    inbox: Number(row?.unread ?? 0),
    calendarToday: Number(row?.today ?? 0) > 0,
    tasksDue: tasks.dueToday + tasks.overdue,
  };
}
