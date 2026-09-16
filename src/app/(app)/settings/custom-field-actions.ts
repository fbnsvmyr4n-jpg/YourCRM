"use server";

import { revalidateApp } from "@/server/revalidate";
import { roleCan } from "@/server/permissions";
import { withCurrentTenant } from "@/server/tenant-session";
import { checkDefinition, FIELD_ENTITIES } from "@/server/custom-field-rules";
import { createField, getField, setFieldArchived, updateField } from "@/server/repos/custom-fields";
import { id as validId, pick } from "@/server/validate";
import { logWrite } from "@/server/log";
import type { FormState } from "./actions";

/**
 * Defining a workspace's custom fields.
 *
 * Customer-data work, so the default CRM gate applies; changing the shape of
 * every contact or deal is further limited to whoever manages the team, the
 * same people who decide who works here. Filling a field in is not limited —
 * that happens on the record, by whoever can edit it.
 */

const NOT_YOURS = "Only somebody who manages the team can change custom fields.";

export async function createCustomFieldAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return withCurrentTenant(async (q) => {
    if (!roleCan(q.ctx.role, "manage_users")) return { error: NOT_YOURS };
    const entity = pick(formData.get("entity"), FIELD_ENTITIES);
    if (!entity) return { error: "Choose whether this field is for contacts or deals." };

    const def = checkDefinition({
      label: formData.get("label"),
      kind: formData.get("kind"),
      options: formData.get("options"),
    });
    if ("error" in def) return { error: def.error };

    const out = await createField(q, `cf_${crypto.randomUUID().replace(/-/g, "")}`, entity, def);
    if ("error" in out) return { error: out.error };
    logWrite("create", "custom_field", { id: out.field.id, actor: q.ctx.userId });
    revalidateApp();
    return { ok: `Added “${out.field.label}”.` };
  });
}

export async function updateCustomFieldAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return withCurrentTenant(async (q) => {
    if (!roleCan(q.ctx.role, "manage_users")) return { error: NOT_YOURS };
    const fieldId = validId(formData.get("id"));
    const existing = fieldId ? await getField(q, fieldId) : null;
    if (!fieldId || !existing) return { error: "That field no longer exists." };

    /* Checked against the field's OWN kind: the form cannot change it. */
    const def = checkDefinition({
      label: formData.get("label"),
      kind: existing.kind,
      options: formData.get("options"),
    });
    if ("error" in def) return { error: def.error };

    const out = await updateField(q, fieldId, def);
    if ("error" in out) return { error: out.error };
    logWrite("update", "custom_field", { id: fieldId, actor: q.ctx.userId });
    revalidateApp();
    return { ok: "Saved." };
  });
}

export async function setCustomFieldArchivedAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return withCurrentTenant(async (q) => {
    if (!roleCan(q.ctx.role, "manage_users")) return { error: NOT_YOURS };
    const fieldId = validId(formData.get("id"));
    if (!fieldId) return { error: "That field no longer exists." };
    const archived = formData.get("archived") === "true";

    const out = await setFieldArchived(q, fieldId, archived);
    if ("error" in out) return { error: out.error };
    logWrite("update", "custom_field", { id: fieldId, actor: q.ctx.userId });
    revalidateApp();
    return { ok: archived ? "Archived. What people typed is kept." : "Restored." };
  });
}
