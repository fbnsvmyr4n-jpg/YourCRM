"use client";

import { AlertCircle, Check } from "lucide-react";
import type { FormState } from "@/app/(app)/settings/actions";

/**
 * The result of a form action, said in one line.
 *
 * Shared rather than duplicated: it moved out of the settings module when the
 * billing card did, and two copies would drift the moment one of them learned
 * about a third state.
 */
export function Banner({ state }: { state: FormState }) {
  if (!state) return null;
  const ok = !!state.ok;
  return (
    <p
      className="flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm"
      style={{
        background: ok ? "var(--green-soft)" : "var(--red-soft)",
        color: ok ? "var(--green)" : "var(--red)",
      }}
    >
      {ok ? <Check className="h-4 w-4 shrink-0" /> : <AlertCircle className="h-4 w-4 shrink-0" />}
      {state.ok ?? state.error}
    </p>
  );
}
