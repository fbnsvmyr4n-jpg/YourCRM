"use client";

import { useState } from "react";
import { MessageSquareText } from "lucide-react";
import {
  MERGE_FIELDS,
  renderTemplate,
  valuesFor,
  type MergeField,
  type MessageTemplate,
  type TemplateChannel,
} from "@/server/template-rules";

/**
 * "Use a template" where a message is written.
 *
 * Only the templates for the channel being written on. Picking one fills it in
 * for the person being written to and hands the text back; anything that could
 * not be filled — a contact with no company on file — is named underneath, so
 * "Hi , " is caught by the writer rather than the client.
 *
 * Nothing is sent from here. The person still reads it and presses Send.
 */
export function TemplatePicker({
  templates,
  channel,
  person,
  me,
  hasText,
  onPick,
}: {
  templates: MessageTemplate[];
  channel: TemplateChannel;
  person: { name: string; company: string } | null;
  me: { name: string; business: string };
  /** Whether something is already written, which a template would replace. */
  hasText: boolean;
  onPick: (filled: { subject: string; body: string }) => void;
}) {
  const [missing, setMissing] = useState<MergeField[]>([]);
  const available = templates.filter((t) => t.channel === channel);
  if (available.length === 0) return null;

  return (
    <div>
      <label className="flex items-center gap-2">
        <MessageSquareText className="h-4 w-4 shrink-0 text-faint" aria-hidden />
        <span className="sr-only">Use a template</span>
        <select
          value=""
          onChange={(e) => {
            const t = available.find((x) => x.id === e.target.value);
            if (!t) return;
            if (hasText && !confirm(`Replace what you have written with “${t.name}”?`)) return;
            const values = valuesFor(person ?? { name: "", company: "" }, me);
            const subject = renderTemplate(t.subject, values);
            const body = renderTemplate(t.body, values);
            setMissing([...new Set([...subject.missing, ...body.missing])]);
            onPick({ subject: subject.text, body: body.text });
          }}
          className="field-input !py-1.5 text-sm"
        >
          <option value="">Use a template…</option>
          {available.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      {missing.length > 0 && (
        <p className="mt-1.5 text-xs" style={{ color: "var(--amber)" }}>
          Left blank — not on file{person?.name ? ` for ${person.name}` : ""}: {missing.map((f) => MERGE_FIELDS[f].toLowerCase()).join(", ")}. Check the
          message before sending.
        </p>
      )}
    </div>
  );
}
