import { notFound } from "next/navigation";
import { listContacts } from "@/server/repos/contacts";
import {
  projectDocuments,
  projectHeader,
  projectPeople,
  projectThreads,
  projectTimeline,
} from "@/server/repos/projects";
import { getSettings } from "@/server/repos/settings";
import { listDependencies, listTasks, summarise } from "@/server/repos/tasks";
import { listUsers } from "@/server/repos/users";
import { instantToWallClock } from "@/lib/zoned";
import { withSystem } from "@/server/tenant";
import { listPriceItems } from "@/server/repos/pricing";
import { requireTenantPage, withTenantPage } from "@/server/tenant-session";
import { ProjectDetail } from "./ProjectDetail";

/* Everything on this page is somebody else's most recent action — a reply that
   arrived, a quote that was accepted. A cached copy is a screen that is wrong
   in the one direction that matters. */
export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  /*
     One tenant round trip for the whole screen.

     Five reads, but each is a single statement covering its whole concern —
     the alternative is a query per person, per document and per thread, which
     on a busy job is dozens of trips to draw one page.
  */
  const data = await withTenantPage(async (q) => {
    const header = await projectHeader(q, id);
    if (!header) return null;
    return {
      header,
      people: await projectPeople(q, id),
      documents: await projectDocuments(q, id),
      /* So a hand-typed document can pick from the price list instead of
         retyping a rate. Active only: a withdrawn rate must not be offered. */
      priceItems: await listPriceItems(q, true),
      threads: await projectThreads(q, id),
      timeline: await projectTimeline(q, id),
      tasks: await listTasks(q, id),
      /* Sent as an array of pairs: a Map cannot cross the server/client
         boundary, and rebuilding one in the view is a line of code against a
         serialisation bug that would otherwise arrive as "dependencies is not
         a function" in production. */
      dependencies: [...(await listDependencies(q, id))].map(([taskId, links]) => ({
        taskId,
        links,
      })),
      /*
         Today, in the BUSINESS's zone rather than the server's.

         "Overdue" and the marker on the chart both turn on which day it is, and
         a server in UTC deciding that for a business in Johannesburg gets it
         wrong for two hours every evening — a task would read as overdue before
         its own due date had ended. Same reasoning as every other date on this
         screen, and the same helper.
      */
      today:
        instantToWallClock(new Date().toISOString(), (await getSettings(q)).timeZone)?.date ??
        new Date().toISOString().slice(0, 10),
      /*
         Candidates for "add somebody to the job": every colleague, and every
         contact — not only the client's own people.

         It filtered to the client's company first, and that was wrong for the
         job this screen describes. A build has an engineer, an architect and
         two subcontractors on it, none of whom work for Heineken; restricting
         the list to Heineken staff made exactly the people Bradley described
         unaddable. The client's own are sorted first and everyone carries their
         company, so the list is still short to scan without being a fence.
      */
      contacts: (await listContacts(q))
        .map((c) => ({
          id: c.id,
          name: `${c.firstName} ${c.lastName}`.trim(),
          company: c.companyName,
          isClient: c.companyId !== null && c.companyId === header.companyId,
        }))
        .sort((a, b) => Number(b.isClient) - Number(a.isClient) || a.name.localeCompare(b.name)),
    };
  });

  /* A project that does not exist, or belongs to another workspace, is the same
     answer: not found. Distinguishing them would confirm the id is real to
     somebody who should not know that. */
  if (!data) notFound();

  const ctx = await requireTenantPage();
  const staff = await withSystem((q) => listUsers(q, ctx.agencyId));

  return (
    <ProjectDetail
      header={data.header}
      people={data.people}
      documents={data.documents}
      priceItems={data.priceItems}
      threads={data.threads}
      timeline={data.timeline}
      tasks={data.tasks}
      dependencies={data.dependencies}
      scheduleSummary={summarise(data.tasks, data.today)}
      today={data.today}
      candidates={{
        staff: staff.map((u) => ({ id: u.id, name: u.name })),
        contacts: data.contacts,
      }}
    />
  );
}
