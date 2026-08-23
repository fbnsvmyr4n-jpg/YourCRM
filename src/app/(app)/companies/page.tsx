import { companyRollups } from "@/server/repos/companies";
import { withTenantPage } from "@/server/tenant-session";
import { CompaniesView } from "./CompaniesView";

export const dynamic = "force-dynamic";

export default async function CompaniesPage() {
  const companies = await withTenantPage((q) => companyRollups(q));
  return <CompaniesView companies={companies} />;
}
