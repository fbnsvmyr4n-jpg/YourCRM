"use client";

import { useActionState, useRef, useState } from "react";
import { useKeptForm } from "@/lib/use-kept-form";
import { MessageSquareText, Plus } from "lucide-react";
import { Card, CardHeader, CardMeta } from "@/components/ui/Card";
import { Banner } from "@/components/ui/Banner";
import { clsx } from "@/lib/clsx";
import { useFormDisclosure } from "@/lib/form-disclosure";
import {
  CHANNEL_LABEL,
  MERGE_FIELDS,
  renderTemplate,
  smsSegments,
  TEMPLATE_CHANNELS,
  valuesFor,
  type MergeField,
  type MessageTemplate,
  type TemplateChannel,
} from "@/server/template-rules";
import type { FormState } from "./actions";
import { createTemplateAction, deleteTemplateAction, updateTemplateAction } from "./template-actions";

/**
 * The words this business sends again and again, written once.
 *
 * The preview fills a template in for an example client as it is typed, so a
 * missing comma after {{first_name}} is seen here rather than by a customer.
 */
export function TemplatesCard({
  templates,
  readerId,
  canManage,
  me,
}: {
  templates: MessageTemplate[];
  readerId: string;
  /** Manages the team: may change anybody's template. */
  canManage: boolean;
  /** For the preview: the reader's own name and the business's. */
  me: { name: string; business: string };
}) {
  const create = useKeptForm<FormState>(createTemplateAction, undefined);
  const createState = create.state;
  const [open, openForm, closeForm] = useFormDisclosure(createState, (s) => Boolean(s?.ok));

  return (
    <Card>
      <CardHeader
        title="Message templates"
        icon={<MessageSquareText className="h-[18px] w-[18px] text-accent" />}
        action={
          <div className="flex items-center gap-2">
            {templates.length > 0 && <CardMeta>{templates.length}</CardMeta>}
            {!open && (
              <button type="button" onClick={openForm} className="btn-accent focus-ring flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-semibold">
                <Plus className="h-3.5 w-3.5" /> New
              </button>
            )}
          </div>
        }
      />
      <div className="flex flex-col gap-3">
        {!open && <Banner state={createState} />}
        {open && <TemplateForm me={me} form={create} onCancel={closeForm} />}

        {templates.length === 0 && !open && (
          <p className="text-sm text-muted">
            Write a message once — a quote follow-up, a booking reminder — and pick it from the Template menu when you
            write to somebody. Their name and company are filled in for you.
          </p>
        )}

        {templates.map((t) => (
          <TemplateRow key={t.id} template={t} me={me} canChange={canManage || t.createdBy === readerId} />
        ))}
      </div>
    </Card>
  );
}

function TemplateRow({ template: t, me, canChange }: { template: MessageTemplate; me: { name: string; business: string }; canChange: boolean }) {
  const edit = useKeptForm<FormState>(updateTemplateAction, undefined);
  const editState = edit.state;
  const [deleteState, remove, deleting] = useActionState<FormState, FormData>(deleteTemplateAction, undefined);
  const [isEditing, openEdit, closeEdit] = useFormDisclosure(editState, (s) => Boolean(s?.ok));
  const [confirming, setConfirming] = useState(false);

  if (isEditing) {
    return <TemplateForm me={me} template={t} form={edit} onCancel={closeEdit} />;
  }
  return (
    <div className="rounded-xl border border-[var(--border)] p-3.5">
      <Banner state={editState} />
      <Banner state={deleteState} />
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-sm font-semibold">{t.name}</p>
        <span className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
          {CHANNEL_LABEL[t.channel]}
        </span>
      </div>
      {t.subject && <p className="mt-1 truncate text-xs font-medium text-muted">{t.subject}</p>}
      <p className="mt-1 line-clamp-2 whitespace-pre-line text-xs text-faint">{t.body}</p>
      {canChange && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <button type="button" onClick={openEdit} className="btn-soft focus-ring rounded-lg px-2.5 py-1.5 text-xs font-medium">
            Edit
          </button>
          {confirming ? (
            <form action={remove} className="flex items-center gap-2">
              <input type="hidden" name="id" value={t.id} />
              <span className="text-xs text-muted">Delete for everyone?</span>
              <button type="button" onClick={() => setConfirming(false)} className="btn-soft focus-ring rounded-lg px-2.5 py-1.5 text-xs font-medium">
                Keep
              </button>
              <button type="submit" disabled={deleting} className="btn-soft focus-ring rounded-lg px-2.5 py-1.5 text-xs font-semibold text-red disabled:opacity-60">
                Delete
              </button>
            </form>
          ) : (
            <button type="button" onClick={() => setConfirming(true)} className="focus-ring rounded-lg px-2 py-1.5 text-xs font-medium text-faint hover:text-[var(--red)]">
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const EXAMPLE = { name: "Amara Dube", company: "Dube Landscaping" };

function TemplateForm({
  me,
  template,
  form,
  onCancel,
}: {
  me: { name: string; business: string };
  template?: MessageTemplate;
  form: ReturnType<typeof useKeptForm<FormState>>;
  onCancel: () => void;
}) {
  const { state, pending, formProps } = form;
  const [channel, setChannel] = useState<TemplateChannel>(template?.channel ?? "whatsapp");
  const [subject, setSubject] = useState(template?.subject ?? "");
  const [body, setBody] = useState(template?.body ?? "");
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const values = valuesFor(EXAMPLE, me);
  const preview = renderTemplate(body, values).text;
  const sms = channel === "sms" ? smsSegments(preview) : null;

  /* Put the field where the cursor is, not at the end: "Hi {{first_name}}," is
     usually written mid-sentence. */
  function insert(field: MergeField) {
    const el = bodyRef.current;
    const token = `{{${field}}}`;
    if (!el) return setBody((b) => b + token);
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    const next = body.slice(0, start) + token + body.slice(end);
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  }

  return (
    <form {...formProps} className="flex flex-col gap-3 rounded-xl border border-[var(--border)] p-3.5">
      <Banner state={state} />
      {template && <input type="hidden" name="id" value={template.id} />}
      <input type="hidden" name="channel" value={channel} />

      <div className="grid grid-cols-1 gap-3 @min-[560px]:grid-cols-[1fr_auto]">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Name</span>
          <input name="name" required maxLength={60} defaultValue={template?.name} placeholder="Quote follow-up" className="field-input" />
        </label>
        <div>
          <span className="mb-1.5 block text-xs font-medium text-muted">Sent by</span>
          <div className="grid grid-cols-3 gap-1 rounded-xl p-1" style={{ background: "var(--raise)" }} role="radiogroup" aria-label="Channel">
            {TEMPLATE_CHANNELS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={channel === c}
                onClick={() => setChannel(c)}
                className={clsx("focus-ring rounded-lg px-3 py-1.5 text-xs font-semibold", channel === c ? "text-accent shadow-sm" : "text-muted")}
                style={channel === c ? { background: "var(--panel-solid)" } : undefined}
              >
                {CHANNEL_LABEL[c]}
              </button>
            ))}
          </div>
        </div>
      </div>

      {channel === "email" && (
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Subject</span>
          <input name="subject" maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} className="field-input" />
        </label>
      )}

      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-muted">Message</span>
        <textarea
          ref={bodyRef}
          name="body"
          required
          rows={5}
          maxLength={5000}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={"Hi {{first_name}}, thanks for your time today…"}
          className="field-input resize-y"
        />
      </label>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-faint">Insert:</span>
        {(Object.keys(MERGE_FIELDS) as MergeField[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => insert(f)}
            title={`{{${f}}}`}
            className="btn-soft focus-ring rounded-full px-2.5 py-1 text-xs font-medium"
          >
            {MERGE_FIELDS[f]}
          </button>
        ))}
      </div>

      {body.trim() && (
        <div className="rounded-xl px-3.5 py-3" style={{ background: "var(--raise)" }}>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
            Preview · to {EXAMPLE.name}
          </p>
          {channel === "email" && subject && <p className="mb-1 text-sm font-semibold">{renderTemplate(subject, values).text}</p>}
          <p className="whitespace-pre-line text-sm">{preview}</p>
          {sms && (
            <p className="mt-2 text-xs text-muted">
              {sms.length} characters · {sms.segments} SMS {sms.segments === 1 ? "segment" : "segments"}
              {sms.encoding === "UCS-2" && " — an emoji or accented letter makes each segment 70 characters"}
            </p>
          )}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn-soft focus-ring rounded-xl px-4 py-2 text-sm font-medium">
          Cancel
        </button>
        <button type="submit" disabled={pending} className="btn-accent focus-ring rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-60">
          {pending ? "Saving…" : "Save template"}
        </button>
      </div>
    </form>
  );
}
