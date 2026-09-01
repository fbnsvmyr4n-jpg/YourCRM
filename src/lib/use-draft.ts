"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * A message in progress, kept when the composer closes.
 *
 * Reported: writing an email, closing the box, and finding the message gone
 * with nothing to go back to. Closing a form is not abandoning what was written
 * in it — a half-finished mail is often closed to go and look something up, and
 * losing it means starting again from memory.
 *
 * Held in `localStorage` rather than on the server, because what is being
 * protected is unsent work on this device and it has to survive the tab
 * closing, a reload and a crash. A draft that needed a round trip would be
 * exactly as lost as before on the occasions the round trip failed.
 *
 * `useSyncExternalStore` rather than an effect that reads storage into state:
 * stored text IS an external mutable source, the server and client snapshots
 * stay explicitly separate so hydration has nothing to mismatch, and setting
 * state inside an effect to do the same job is what the React compiler rejects.
 * Same reasoning as [[remembered-toggle]], which this borrows wholesale.
 */
export type Draft = { to: string; subject: string; body: string };

export const EMPTY_DRAFT: Draft = { to: "", subject: "", body: "" };

/** Whether anything has actually been written. Whitespace is not a draft. */
export function hasContent(d: Draft): boolean {
  return Boolean(d.to.trim() || d.subject.trim() || d.body.trim());
}

export function useDraft(key: string) {
  const draft = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => EMPTY_DRAFT
  );

  /* Written on every keystroke rather than on close. A draft that only saved
     when the composer was dismissed politely would not survive the two ways
     work actually disappears: a reload, and a tab that never closes politely. */
  const save = useCallback((next: Draft) => write(key, next), [key]);
  const clear = useCallback(() => write(key, EMPTY_DRAFT), [key]);

  return { draft, save, clear };
}

const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  /* Another tab is a legitimate second writer, and `storage` only fires there —
     never in the tab that made the change, which is why writes notify the local
     listeners by hand. */
  const onStorage = () => onChange();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/*
   The snapshot has to be the SAME object while the stored text is unchanged.
   `useSyncExternalStore` compares snapshots by identity, so parsing afresh on
   every call would report a change on every render and loop forever.
*/
let cachedRaw: string | null = null;
let cachedDraft: Draft = EMPTY_DRAFT;

function read(key: string): Draft {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    /* Private windows and browsers set to block site data throw here rather
       than returning null. A composer that cannot save a draft is still a
       composer; losing the recovery is not a reason to fail to render. */
    return EMPTY_DRAFT;
  }
  if (raw === cachedRaw) return cachedDraft;
  cachedRaw = raw;
  cachedDraft = parse(raw);
  return cachedDraft;
}

function parse(raw: string | null): Draft {
  if (!raw) return EMPTY_DRAFT;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return EMPTY_DRAFT;
    const d = parsed as Partial<Draft>;
    /* Field by field rather than trusting the shape. Anything else could be in
       this key — an older build, another tab, someone with devtools open — and
       none of it may reach an input's value as a non-string. */
    const draft: Draft = {
      to: typeof d.to === "string" ? d.to : "",
      subject: typeof d.subject === "string" ? d.subject : "",
      body: typeof d.body === "string" ? d.body : "",
    };
    return hasContent(draft) ? draft : EMPTY_DRAFT;
  } catch {
    return EMPTY_DRAFT;
  }
}

function write(key: string, next: Draft): void {
  try {
    if (hasContent(next)) window.localStorage.setItem(key, JSON.stringify(next));
    else window.localStorage.removeItem(key);
  } catch {
    /* Out of quota, or storage denied. The text stays in the form; only its
       recovery is lost, which is where this started. */
  }
  for (const listener of listeners) listener();
}

/**
 * Unsaved text for one record, kept until it is saved or thrown away.
 *
 * The meeting notes box lost whatever had been typed the moment another
 * meeting was picked from the dropdown, and again on a reload — the same way
 * the email composer used to. Nothing warned about it, and a warning is the
 * wrong answer: the work should simply still be there.
 *
 * Keyed per record, so notes for one meeting can never surface against
 * another. `saved` is what the server holds; a draft is only stored while it
 * DIFFERS from that, so going back to the saved wording clears the draft
 * rather than pinning a copy of it forever.
 */
export function useTextDraft(key: string, saved: string) {
  const stored = useSyncExternalStore(
    subscribe,
    () => readText(key),
    () => null
  );
  const value = stored ?? saved;

  const setValue = useCallback(
    (next: string) => {
      try {
        if (next === saved) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, next);
      } catch {
        /* Storage denied or full. The text stays in the field; only its
           recovery is lost, which is where this started. */
      }
      for (const listener of listeners) listener();
    },
    [key, saved]
  );

  const clear = useCallback(() => {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* As above. */
    }
    for (const listener of listeners) listener();
  }, [key]);

  return { value, setValue, clear, isDraft: stored !== null && stored !== saved };
}

/* Same identity rule as the composer's snapshot: `useSyncExternalStore`
   compares by identity, and a string read from storage is stable, so this one
   needs no cache. */
function readText(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
