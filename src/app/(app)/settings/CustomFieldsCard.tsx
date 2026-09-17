"use client";

import { useState } from "react";
import { useKeptForm } from "@/lib/use-kept-form";
import { Archive, ArchiveRestore, ListPlus, Pencil, Plus } from "lucide-react";
import { Card, CardHeader, CardMeta } from "@/components/ui/Card";
import { Banner } from "@/components/ui/Banner";
import { clsx } from "@/lib/clsx";
import { useFormDisclosure } from "@/lib/form-disclosure";
import {
  FIELD_KINDS,
  KIND_LABEL,
  type CustomField,
  type FieldEntity,
  type FieldKind,
} from "@/server/custom-field-rules";
import type { FormState } from "./actions";
import {
  createCustomFieldAction,
  setCustomFieldArchivedAction,
  updateCustomFieldAction,
} from "./custom-field-actions";

/**
 * The fields this business records that the product does not ship with.
 *
 * One list at a time — contacts or deals — because the two are filled in on
 * different screens and nobody looks for them side by side. Archived fields
 * fold away underneath, so the list shows what forms will actually ask for.
 */

const ENTITY_LABEL: Record<FieldEntity, { tab: string; where: string }> = {
  contact: { tab: "Contacts", where: "Filled in under Edit Contact, shown on each contact." },
  deal: { tab: "Deals", where: "Filled in under Edit details on each project." },
};

export function CustomFieldsCard({
  contactFields,
  dealFields,
  canManage,
}: {
  /** Including archived ones. */
  contactFields: CustomField[];
  dealFields: CustomField[];
  canManage: boolean;
}) {
  const [entity, setEntity] = useState<FieldEntity>("contact");
  const all = entity === "contact" ? contactFields : dealFields;
  const live = all.filter((f) => !f.archived);
  const archived = all.filter((f) => f.archived);
  const [showArchived, setShowArchived] = useState(false);
  const totalLive = [...contactFields, ...dealFields].filter((f) => !f.archived).length;

  return (
    <Card className="card-q">
      <CardHeader
        title="Custom fields"
        icon={<ListPlus className="h-[18px] w-[18px] text-accent" />}
        action={totalLive > 0 ? <CardMeta value={totalLive}>in use</CardMeta> : undefined}
      />

      <div className="mb-3 grid grid-cols-2 gap-1.5 @min-[440px]:inline-grid @min-[440px]:w-auto">
        {(["contact", "deal"] as const).map((e) => {
          const count = (e === "contact" ? contactFields : dealFields).filter((f) => !f.archived).length;
          return (
            <button
              key={e}
              type="button"
              onClick={() => {
                setEntity(e);
                setShowArchived(false);
              }}
              aria-pressed={entity === e}
              className={clsx(
                "focus-ring rounded-xl px-4 py-2 text-sm font-medium transition-colors",
                entity === e ? "text-accent" : "btn-soft text-muted"
              )}
              style={entity === e ? { background: "var(--accent-soft)" } : undefined}
            >
              {ENTITY_LABEL[e].tab}
              {count > 0 && <span className="ml-1.5 tabular-nums text-xs opacity-70">{count}</span>}
            </button>
          );
        })}
      </div>

      <p className="mb-3 text-xs text-faint">
        {live.length === 0
          ? `No custom fields on ${ENTITY_LABEL[entity].tab.toLowerCase()} yet. Add the details your business records that are not already here — a site access code, a lifting capacity, whether a PO is required.`
          : ENTITY_LABEL[entity].where}
      </p>

      {live.length > 0 && (
        <ul className="mb-3 flex flex-col gap-2">
          {live.map((field) => (
            <FieldRow key={field.id} field={field} canManage={canManage} />
          ))}
        </ul>
      )}

      {archived.length > 0 && (
        <div className="mb-3">
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            aria-expanded={showArchived}
            className="focus-ring rounded-lg text-xs font-medium text-muted hover:text-[var(--text)]"
          >
            {showArchived ? "Hide" : "Show"} {archived.length} archived
          </button>
          {showArchived && (
            <ul className="mt-2 flex flex-col gap-2">
              {archived.map((field) => (
                <FieldRow key={field.id} field={field} canManage={canManage} />
              ))}
            </ul>
          )}
        </div>
      )}

      {canManage ? (
        <NewField key={entity} entity={entity} />
      ) : (
        <p className="text-xs text-faint">Only somebody who manages the team can change custom fields.</p>
      )}
    </Card>
  );
}

function FieldRow({ field, canManage }: { field: CustomField; canManage: boolean }) {
  const { state: editState, onSubmit: edit, pending: saving } = useKeptForm<FormState>(updateCustomFieldAction, undefined);
  const { state: archiveState, onSubmit: archive, pending: archiving } = useKeptForm<FormState>(setCustomFieldArchivedAction,
    undefined);
  const [editing, openEdit, closeEdit] = useFormDisclosure(editState, (s) => Boolean(s?.ok));
  const error = archiveState?.error ?? (!editing ? editState?.error : undefined);

  if (editing) {
    return (
      <li className="rounded-xl px-3.5 py-3" style={{ background: "var(--surface-2)" }}>
        <form onSubmit={edit} className="space-y-3">
          {editState?.error && <Banner state={editState} />}
          <input type="hidden" name="id" value={field.id} />
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Name</span>
            <input name="label" defaultValue={field.label} maxLength={60} required className="field-input" />
          </label>
          {field.kind === "choice" && (
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted">Choices, one per line</span>
              <textarea
                name="options"
                defaultValue={field.options.join("\n")}
                rows={Math.min(8, Math.max(3, field.options.length + 1))}
                className="field-input resize-y"
              />
            </label>
          )}
          <p className="text-xs text-faint">
            A {KIND_LABEL[field.kind].toLowerCase()} field stays one — changing its kind would reinterpret what people
            have already typed.
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={closeEdit} className="focus-ring rounded-xl px-4 py-2 text-xs font-medium text-muted">
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="btn-accent focus-ring rounded-xl px-4 py-2 text-xs font-semibold disabled:opacity-60"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li className="rounded-xl px-3.5 py-3" style={{ background: "var(--surface-2)" }}>
      <div className="flex items-center gap-3">
        <div className={clsx("min-w-0 flex-1 leading-tight", field.archived && "opacity-60")}>
          <p className="truncate text-sm font-medium">{field.label}</p>
          <p className="mt-0.5 truncate text-xs text-muted">
            {KIND_LABEL[field.kind]}
            {field.kind === "choice" && ` · ${field.options.join(", ")}`}
          </p>
        </div>
        {canManage && (
          <div className="flex shrink-0 items-center gap-1.5">
            {!field.archived && (
              <button
                type="button"
                onClick={openEdit}
                aria-label={`Edit ${field.label}`}
                className="btn-soft focus-ring grid h-8 w-8 place-items-center rounded-lg text-muted"
              >
                <Pencil className="h-4 w-4" />
              </button>
            )}
            <form onSubmit={archive}>
              <input type="hidden" name="id" value={field.id} />
              <input type="hidden" name="archived" value={field.archived ? "false" : "true"} />
              <button
                type="submit"
                disabled={archiving}
                aria-label={field.archived ? `Restore ${field.label}` : `Archive ${field.label}`}
                title={field.archived ? "Restore" : "Archive — hides it, keeps its values"}
                className="btn-soft focus-ring grid h-8 w-8 place-items-center rounded-lg text-muted disabled:opacity-60"
              >
                {field.archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
              </button>
            </form>
          </div>
        )}
      </div>
      {error && (
        <p className="mt-2 text-xs" style={{ color: "var(--red)" }}>
          {error}
        </p>
      )}
      {!error && editState?.ok && (
        <p className="mt-2 text-xs" style={{ color: "var(--green)" }}>
          {editState.ok}
        </p>
      )}
    </li>
  );
}

function NewField({ entity }: { entity: FieldEntity }) {
  const { state, onSubmit: action, pending } = useKeptForm<FormState>(createCustomFieldAction, undefined);
  const [open, show, hide] = useFormDisclosure(state, (s) => Boolean(s?.ok));
  const [kind, setKind] = useState<FieldKind>("text");

  if (!open) {
    return (
      <div className="space-y-3">
        <Banner state={state} />
        <button
          type="button"
          onClick={() => {
            setKind("text");
            show();
          }}
          className="btn-soft focus-ring flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm font-medium"
        >
          <Plus className="h-4 w-4 text-accent" />
          New field on {ENTITY_LABEL[entity].tab.toLowerCase()}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={action} className="space-y-3 rounded-xl border border-[var(--border)] p-3.5">
      {state?.error && <Banner state={state} />}
      <input type="hidden" name="entity" value={entity} />
      <div className="grid grid-cols-1 gap-3 @min-[440px]:grid-cols-2">
        <label className="block min-w-0">
          <span className="mb-1.5 block text-xs font-medium text-muted">Name</span>
          <input
            name="label"
            maxLength={60}
            required
            autoFocus
            placeholder={entity === "deal" ? "Lifting capacity" : "Site induction done"}
            className="field-input"
          />
        </label>
        <label className="block min-w-0">
          <span className="mb-1.5 block text-xs font-medium text-muted">Kind</span>
          <select
            name="kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as FieldKind)}
            className="field-input"
          >
            {FIELD_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {kind === "choice" && (
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Choices, one per line</span>
          <textarea name="options" rows={4} placeholder={"Tower crane\nMobile crane\nCrawler crane"} className="field-input resize-y" />
        </label>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={hide} className="focus-ring rounded-xl px-4 py-2.5 text-sm font-medium text-muted">
          Cancel
        </button>
        <button
          type="submit"
          disabled={pending}
          className="btn-accent focus-ring rounded-xl px-5 py-2.5 text-sm font-semibold disabled:opacity-60"
        >
          {pending ? "Adding…" : "Add field"}
        </button>
      </div>
    </form>
  );
}
