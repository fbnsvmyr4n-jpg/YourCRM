"use server";

import { revalidatePath } from "next/cache";
import { LEAD_SOURCES, LEAD_STATUSES } from "@/data/leads";
import { createLead, deleteLead, updateLead, type NewLead } from "@/server/leads-repo";
import { detachLead } from "@/server/calls-repo";
import { email as validEmail, id as validId, pick, text } from "@/server/validate";

/** Returns null when the submission can't be trusted, so the caller rejects it. */
function parseLead(formData: FormData): NewLead | null {
  const name = text(formData.get("name"), 80);
  const email = validEmail(formData.get("email"));
  const status = pick(formData.get("status"), LEAD_STATUSES);
  const source = pick(formData.get("source"), LEAD_SOURCES);

  // Status and source drive the Reports funnel and the lead-source donut —
  // an unrecognised value there silently corrupts every chart on that page.
  if (!name || email === null || !status || !source) return null;

  return {
    name,
    email,
    phone: text(formData.get("phone"), 40),
    location: text(formData.get("location"), 80),
    company: text(formData.get("company"), 80),
    status,
    source,
  };
}

export async function addLeadAction(formData: FormData) {
  const input = parseLead(formData);
  if (!input) return;
  const created = await createLead(input);
  revalidatePath("/leads");
  return created.id;
}

export async function updateLeadAction(id: string, formData: FormData) {
  const leadId = validId(id);
  const input = parseLead(formData);
  if (!leadId || !input) return;
  await updateLead(leadId, input);
  revalidatePath("/leads");
}

export async function deleteLeadAction(id: string) {
  const leadId = validId(id);
  if (!leadId) return;

  await deleteLead(leadId);
  // Referential integrity: calls that produced this lead must stop pointing at
  // it, or the Voice Agent detail keeps claiming "Added to Leads" for a record
  // that no longer exists. Runs after the lead write completes — the two locks
  // are sequential, never nested.
  await detachLead(leadId);

  revalidatePath("/leads");
  revalidatePath("/voice-agents");
}
