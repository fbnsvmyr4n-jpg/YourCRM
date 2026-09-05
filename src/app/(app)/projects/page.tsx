import { groupByCompany, listProjects } from "@/server/projects-view";
import { withTenantPage } from "@/server/tenant-session";
import { ProjectsView } from "./ProjectsView";

/* A stage moved on the board has to show here on the next look — this is the
   same records seen a different way, and a cached copy would make the two
   screens disagree about the thing they share. */
export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const rows = await withTenantPage((q) => listProjects(q));
  return <ProjectsView companies={groupByCompany(rows)} />;
}
