"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { Overlay } from "@/components/ui/Overlay";
import { clsx } from "@/lib/clsx";
import { MAX_TAG_NAME, TAG_COLORS, TAG_TONE, type Tag, type TagColor } from "@/server/contact-filter";
import {
  addTagToContactAction,
  deleteTagAction,
  removeTagFromContactAction,
  updateTagAction,
} from "@/app/(app)/contacts/actions";

/**
 * Tags on contacts: the chip, the picker on a person, and the dialog that
 * renames, recolours and deletes them.
 *
 * Nothing here holds its own copy of the tags. Every action revalidates the
 * page, and the tags come back down as props — so the chip on a person, the
 * count in the filter and the dot on the row cannot disagree.
 */

export function TagDot({ color, className }: { color: TagColor; className?: string }) {
  return <span className={clsx("h-2 w-2 shrink-0 rounded-full", className)} style={{ background: TAG_TONE[color].color }} />;
}

export function TagChip({ tag, onRemove, busy }: { tag: Pick<Tag, "name" | "color">; onRemove?: () => void; busy?: boolean }) {
  const tone = TAG_TONE[tag.color];
  return (
    <span
      className="inline-flex max-w-full items-center gap-1.5 rounded-full py-1 pl-2.5 text-xs font-medium"
      style={{ background: tone.soft, color: tone.color, paddingRight: onRemove ? 4 : 10 }}
    >
      <TagDot color={tag.color} className="h-1.5 w-1.5" />
      <span className="truncate">{tag.name}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          disabled={busy}
          aria-label={`Remove the tag ${tag.name}`}
          className="focus-ring -my-1 grid h-7 w-7 shrink-0 place-items-center rounded-full opacity-70 transition-opacity hover:opacity-100 disabled:opacity-40"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

/**
 * The tags on one person, and the way to add another.
 *
 * Typing either finds a tag — in any case, so "cape town" is Cape Town — or
 * offers to make it. It stays open after each one: people tag in threes.
 */
export function ContactTags({ contactId, tags, onContact }: { contactId: string; tags: Tag[]; onContact: string[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  /* A different person is a different question. */
  const [shownFor, setShownFor] = useState(contactId);
  if (shownFor !== contactId) {
    setShownFor(contactId);
    setOpen(false);
    setQuery("");
    setError(null);
  }

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const byId = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags]);
  const current = onContact.map((id) => byId.get(id)).filter((t): t is Tag => Boolean(t));
  const typed = query.replace(/\s+/g, " ").trim();
  const exact = tags.find((t) => t.name.toLowerCase() === typed.toLowerCase());
  const suggestions = tags
    .filter((t) => !onContact.includes(t.id) && t.name.toLowerCase().includes(typed.toLowerCase()))
    .slice(0, 6);

  async function run(fn: () => Promise<{ error: string } | { ok: true }>) {
    setBusy(true);
    setError(null);
    try {
      const out = await fn();
      if ("error" in out) setError(out.error);
      else setQuery("");
    } finally {
      setBusy(false);
    }
  }

  function submit() {
    if (!typed) return;
    if (exact && onContact.includes(exact.id)) {
      setQuery("");
      return;
    }
    void run(() => addTagToContactAction(contactId, exact ? { tagId: exact.id } : { name: typed }));
  }

  return (
    <div ref={boxRef}>
      <div className="flex flex-wrap items-center gap-1.5">
        {current.map((t) => (
          <TagChip key={t.id} tag={t} busy={busy} onRemove={() => void run(() => removeTagFromContactAction(contactId, t.id))} />
        ))}
        {!open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="focus-ring inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--border-strong)] px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:text-[var(--text)]"
          >
            <Plus className="h-3 w-3" /> {current.length ? "Add" : "Add a tag"}
          </button>
        )}
      </div>

      {open && (
        <div className="mt-2.5">
          <input
            autoFocus
            value={query}
            maxLength={MAX_TAG_NAME}
            disabled={busy}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                setOpen(false);
              }
            }}
            placeholder={tags.length ? "Find or make a tag" : "Name a tag, e.g. Cape Town"}
            aria-label="Find or make a tag"
            className="field-input"
          />
          {(suggestions.length > 0 || (typed && !exact)) && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {suggestions.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => addTagToContactAction(contactId, { tagId: t.id }))}
                  className="focus-ring rounded-full transition-opacity hover:opacity-80 disabled:opacity-50"
                >
                  <TagChip tag={t} />
                </button>
              ))}
              {typed && !exact && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={submit}
                  className="focus-ring inline-flex max-w-full items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold text-accent"
                  style={{ background: "var(--accent-soft)" }}
                >
                  <Plus className="h-3 w-3 shrink-0" /> <span className="truncate">Make “{typed}”</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {error && (
        <p className="mt-2 text-xs" style={{ color: "var(--red)" }}>
          {error}
        </p>
      )}
    </div>
  );
}

/** Rename, recolour and delete — for whoever manages the team. */
export function EditTagsDialog({ tags, onClose }: { tags: Tag[]; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  async function run(id: string, fn: () => Promise<{ error: string } | { ok: true }>) {
    setBusyId(id);
    setError(null);
    try {
      const out = await fn();
      if ("error" in out) setError(out.error);
    } finally {
      setBusyId(null);
      setConfirming(null);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <Overlay>
      <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true" aria-label="Edit tags">
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
        <div className="modal-surface relative z-10 w-full max-w-md p-6">
          <div className="mb-1 flex items-start justify-between gap-3">
            <h2 className="text-lg font-semibold tracking-tight">Edit tags</h2>
            <button type="button" onClick={onClose} className="shrink-0 text-faint hover:text-[var(--text)]" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>
          <p className="mb-4 text-sm text-muted">Changes apply to every contact carrying the tag.</p>

          {error && (
            <p className="mb-3 rounded-xl px-3.5 py-2.5 text-sm" style={{ background: "var(--red-soft)", color: "var(--red)" }}>
              {error}
            </p>
          )}

          <ul className="flex flex-col gap-1">
            {tags.map((t) => (
              <li key={t.id} className="rounded-xl border border-[var(--border)] p-3">
                {confirming === t.id ? (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm">
                      Delete <strong>{t.name}</strong>? It comes off {t.contacts === 1 ? "1 contact" : `${t.contacts} contacts`}; the
                      contacts stay.
                    </p>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => setConfirming(null)} className="btn-soft focus-ring rounded-lg px-3 py-1.5 text-xs font-medium">
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={busyId === t.id}
                        onClick={() => void run(t.id, () => deleteTagAction(t.id))}
                        className="btn-soft focus-ring rounded-lg px-3 py-1.5 text-xs font-semibold text-red disabled:opacity-60"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <TagDot color={t.color} className="h-2.5 w-2.5" />
                      <input
                        /* Keyed on the saved name, so a refused rename snaps
                           back to what is really stored. */
                        key={t.name}
                        defaultValue={t.name}
                        maxLength={MAX_TAG_NAME}
                        aria-label={`Name of the tag ${t.name}`}
                        disabled={busyId === t.id}
                        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                        onBlur={(e) => {
                          const name = e.currentTarget.value.trim();
                          if (name && name !== t.name) void run(t.id, () => updateTagAction(t.id, name, t.color));
                          else e.currentTarget.value = t.name;
                        }}
                        className="min-w-0 flex-1 rounded-lg bg-transparent px-1.5 py-1 text-sm font-medium outline-none focus:bg-[var(--raise)]"
                      />
                      <span className="shrink-0 text-xs tabular-nums text-faint">{t.contacts}</span>
                      <button
                        type="button"
                        onClick={() => setConfirming(t.id)}
                        aria-label={`Delete the tag ${t.name}`}
                        className="focus-ring grid h-8 w-8 shrink-0 place-items-center rounded-lg text-faint hover:text-[var(--red)]"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5 pl-[18px]" role="radiogroup" aria-label={`Colour of ${t.name}`}>
                      {TAG_COLORS.map((c) => (
                        <button
                          key={c}
                          type="button"
                          role="radio"
                          aria-checked={t.color === c}
                          aria-label={c}
                          disabled={busyId === t.id}
                          onClick={() => t.color !== c && void run(t.id, () => updateTagAction(t.id, t.name, c))}
                          className={clsx(
                            "focus-ring h-6 w-6 rounded-full border-2 transition-transform hover:scale-110",
                            t.color === c ? "border-[var(--text)]" : "border-transparent"
                          )}
                          style={{ background: TAG_TONE[c].color }}
                        />
                      ))}
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Overlay>
  );
}
