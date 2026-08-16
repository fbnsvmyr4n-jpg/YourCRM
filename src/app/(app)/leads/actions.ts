"use server";

import { revalidateApp } from "@/server/revalidate";
import { LEAD_SOURCES } from "@/data/leads";
import { createLead, deleteLead, updateLead, type NewLead } from "@/server/leads-repo";
import { detachLead } from "@/server/calls-repo";
import { email as validEmail, id as validId, pick, text } from "@/server/validate";
import { requireUser } from "@/server/session";

/** Returns null when the submission can't be trusted, so the caller rejects it. */
function parseLead(formData: FormData): NewLead | null {
  const name = text(formData.get("name"), 80);
  const email = validEmail(formData.get("email"));
  const source = pick(formData.get("source"), LEAD_SOURCES);

  // Source drives the lead-source breakdown — an unrecognised value there
  // silently corrupts the chart. Status is deliberately *not* read from the
  // form: it is derived from calls, meetings and deals, so accepting one here
  // would let a posted value contradict what actually happened.
  if (!name || email === null || !source) return null;

  return {
    name,
    email,
    phone: text(formData.get("phone"), 40),
    location: text(formData.get("location"), 80),
    company: text(formData.get("company"), 80),
    // Every lead starts here; it moves on its own as events land.
    status: "New Lead",
    source,
  };
}

export async function addLeadAction(formData: FormData) {
  await requireUser();
  const input = parseLead(formData);
  if (!input) return;
  const created = await createLead(input);
  revalidateApp();
  return created.id;
}

export async function updateLeadAction(id: string, formData: FormData) {
  await requireUser();
  const leadId = validId(id);
  const input = parseLead(formData);
  if (!leadId || !input) return;
  await updateLead(leadId, input);
  revalidateApp();
}

export async function deleteLeadAction(id: string) {
  await requireUser();
  const leadId = validId(id);
  if (!leadId) return;

  await deleteLead(leadId);
  // Referential integrity: calls that produced this lead must stop pointing at
  // it, or the Voice Agent detail keeps claiming "Added to Leads" for a record
  // that no longer exists. Runs after the lead write completes — the two locks
  // are sequential, never nested.
  await detachLead(leadId);

  revalidateApp();
}
