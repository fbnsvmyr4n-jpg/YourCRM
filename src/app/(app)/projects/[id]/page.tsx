import { notFound } from "next/navigation";
import { listContacts } from "@/server/repos/contacts";
import {
  projectDocuments,
  projectHeader,
  projectPeople,
  projectThreads,
  projectTimeline,
} from "@/server/repos/projects";
import { listUsers } from "@/server/repos/users";
import { withSystem } from "@/server/tenant";
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
      threads: await projectThreads(q, id),
      timeline: await projectTimeline(q, id),
      /* Candidates for "add somebody to the job": everyone at the client, and
         every colleague. Read here rather than in the client component so the
         list cannot be stale, and so the component never needs a fetch. */
      contacts: (await listContacts(q))
        .filter((c) => c.companyId === header.companyId || header.companyId === null)
        .map((c) => ({ id: c.id, name: `${c.firstName} ${c.lastName}`.trim() })),
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
      threads={data.threads}
      timeline={data.timeline}
      candidates={{
        staff: staff.map((u) => ({ id: u.id, name: u.name })),
        contacts: data.contacts,
      }}
    />
  );
}
