"use server";

import { revalidateApp } from "@/server/revalidate";
import { roleCan } from "@/server/permissions";
import { withCurrentTenant } from "@/server/tenant-session";
import { checkDraft, MAX_AUTOMATIONS } from "@/server/automation-rules";
import {
  assignableTeam,
  createAutomation,
  deleteAutomation,
  listAutomations,
  setAutomationEnabled,
} from "@/server/repos/automations";
import { id as validId } from "@/server/validate";
import { logWrite } from "@/server/log";
import type { FormState } from "./actions";

/**
 * Making, pausing and removing automations.
 *
 * Customer-data work, so the default CRM gate applies. On top of it, only a
 * role that manages the team may change a rule: a rule decides whose desk every
 * new lead lands on, which is the same kind of decision as who is on the team.
 * The control is hidden from everybody else; this is the refusal that counts.
 */

const NOT_YOURS = "Only somebody who manages the team can change automations.";

export async function createAutomationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return withCurrentTenant(async (q) => {
    if (!roleCan(q.ctx.role, "manage_users")) return { error: NOT_YOURS };

    const checked = checkDraft({
      eventKind: formData.get("eventKind"),
      whenSource: formData.get("whenSource"),
      whenStage: formData.get("whenStage"),
      actionKind: formData.get("actionKind"),
      /* In the order they were ticked — the form posts them that way — which is
         the order a rotation takes turns in. */
      assigneeIds: formData.getAll("assignee"),
      targetStage: formData.get("targetStage"),
      taskTitle: formData.get("taskTitle"),
      taskDueDays: formData.get("taskDueDays"),
    });
    if ("error" in checked) return { error: checked.error };

    if ((await listAutomations(q)).length >= MAX_AUTOMATIONS) {
      return {
        error: `A workspace can have up to ${MAX_AUTOMATIONS} automations. Delete one you no longer use first.`,
      };
    }

    /* Ids arrive from the browser. Each must be somebody who can actually be
       given work here — otherwise a rule could name a person from another
       customer's account, or the IT administrator who cannot open a lead. */
    if (checked.draft.actionKind === "assign_owner") {
      const team = new Set((await assignableTeam(q)).map((p) => p.id));
      if (checked.draft.assigneeIds.some((personId) => !team.has(personId))) {
        return { error: "One of those people cannot be given leads in this workspace." };
      }
    }

    const created = await createAutomation(q, `au_${crypto.randomUUID().replace(/-/g, "")}`, checked.draft);
    logWrite("create", "automation", { id: created.id, actor: q.ctx.userId });
    revalidateApp();
    return { ok: "Saved. It applies to leads and deals from now on." };
  });
}

export async function setAutomationEnabledAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return withCurrentTenant(async (q) => {
    if (!roleCan(q.ctx.role, "manage_users")) return { error: NOT_YOURS };
    const automationId = validId(formData.get("id"));
    if (!automationId) return { error: "That automation no longer exists." };

    const enabled = formData.get("enabled") === "true";
    if (!(await setAutomationEnabled(q, automationId, enabled))) {
      return { error: "That automation no longer exists." };
    }
    logWrite("update", "automation", { id: automationId, actor: q.ctx.userId });
    revalidateApp();
    return { ok: enabled ? "Turned on." : "Turned off." };
  });
}

export async function deleteAutomationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return withCurrentTenant(async (q) => {
    if (!roleCan(q.ctx.role, "manage_users")) return { error: NOT_YOURS };
    const automationId = validId(formData.get("id"));
    if (!automationId || !(await deleteAutomation(q, automationId))) {
      return { error: "That automation no longer exists." };
    }
    logWrite("delete", "automation", { id: automationId, actor: q.ctx.userId });
    revalidateApp();
    return { ok: "Deleted." };
  });
}
