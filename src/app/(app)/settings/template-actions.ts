"use server";

import { revalidateApp } from "@/server/revalidate";
import { roleCan } from "@/server/permissions";
import { withCurrentTenant } from "@/server/tenant-session";
import type { TenantQuery } from "@/server/tenant";
import { checkTemplate } from "@/server/template-rules";
import { createTemplate, deleteTemplate, getTemplate, updateTemplate } from "@/server/repos/templates";
import { id as validId } from "@/server/validate";
import { logWrite } from "@/server/log";
import type { FormState } from "./actions";

/**
 * Message templates.
 *
 * Writing to customers is CRM work, so the default customer-data gate applies.
 * Anybody who writes to clients can add a template; changing or deleting one
 * is for whoever wrote it or whoever manages the team — the words a colleague
 * relies on should not change under them.
 */

const readForm = (formData: FormData) =>
  checkTemplate({
    name: formData.get("name"),
    channel: formData.get("channel"),
    subject: formData.get("subject"),
    body: formData.get("body"),
  });

async function mayChange(q: TenantQuery, id: string): Promise<{ ok: true } | { error: string }> {
  const existing = await getTemplate(q, id);
  if (!existing) return { error: "That template no longer exists." };
  if (existing.createdBy !== q.ctx.userId && !roleCan(q.ctx.role, "manage_users")) {
    return { error: "Only whoever wrote this template, or somebody who manages the team, can change it." };
  }
  return { ok: true };
}

export async function createTemplateAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return withCurrentTenant(async (q) => {
    const input = readForm(formData);
    if ("error" in input) return { error: input.error };
    const out = await createTemplate(q, input);
    if ("error" in out) return { error: out.error };
    logWrite("create", "message_template", { id: out.template.id, actor: q.ctx.userId });
    revalidateApp();
    return { ok: `Saved “${out.template.name}”. It is in the Template menu when you write.` };
  });
}

export async function updateTemplateAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return withCurrentTenant(async (q) => {
    const id = validId(formData.get("id"));
    if (!id) return { error: "That template no longer exists." };
    const allowed = await mayChange(q, id);
    if ("error" in allowed) return { error: allowed.error };
    const input = readForm(formData);
    if ("error" in input) return { error: input.error };
    const out = await updateTemplate(q, id, input);
    if ("error" in out) return { error: out.error };
    logWrite("update", "message_template", { id, actor: q.ctx.userId });
    revalidateApp();
    return { ok: "Saved." };
  });
}

export async function deleteTemplateAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return withCurrentTenant(async (q) => {
    const id = validId(formData.get("id"));
    if (!id) return { error: "That template no longer exists." };
    const allowed = await mayChange(q, id);
    if ("error" in allowed) return { error: allowed.error };
    if (!(await deleteTemplate(q, id))) return { error: "That template no longer exists." };
    logWrite("delete", "message_template", { id, actor: q.ctx.userId });
    revalidateApp();
    return { ok: "Deleted." };
  });
}
