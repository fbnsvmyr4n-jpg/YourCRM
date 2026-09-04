import { listNotes } from "@/server/notes-view";
import { withTenantPage } from "@/server/tenant-session";
import { NotesView } from "./NotesView";

/* Notes are written continuously and read occasionally, so this must reflect
   what was typed a moment ago rather than a cached copy of yesterday. */
export const dynamic = "force-dynamic";

export default async function NotesPage() {
  const notes = await withTenantPage((q) => listNotes(q));
  return <NotesView notes={notes} />;
}
