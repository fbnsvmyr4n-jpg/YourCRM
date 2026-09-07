import { countUnfiled, groupByCompany, listProjects } from "@/server/projects-view";
import { withTenantPage } from "@/server/tenant-session";
import { ProjectsView } from "./ProjectsView";

/* A stage moved on the board has to show here on the next look — this is the
   same records seen a different way, and a cached copy would make the two
   screens disagree about the thing they share. */
export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  /* Both in one pass. Read separately, the page could report "nothing here"
     and "nothing unfiled" from two different moments and be wrong about both. */
  const { rows, unfiled } = await withTenantPage(async (q) => ({
    rows: await listProjects(q),
    unfiled: await countUnfiled(q),
  }));
  return <ProjectsView companies={groupByCompany(rows)} unfiled={unfiled} />;
}
