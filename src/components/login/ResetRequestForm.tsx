"use client";

import { useActionState } from "react";
import { AlertCircle, Check, Mail } from "lucide-react";
import { requestResetAction, type ResetState } from "@/app/(auth)/reset-actions";

/**
 * The "forgot password" request, revealed inline beneath the sign-in form.
 *
 * Its own <form> element rather than part of the sign-in form — nesting forms
 * is invalid HTML and would break the sign-in submit.
 */
export function ResetRequestForm() {
  const [state, action, pending] = useActionState<ResetState, FormData>(requestResetAction, undefined);

  return (
    <form action={action} className="mt-4 rounded-2xl bg-white/[0.035] p-3.5">
      <p className="mb-2.5 text-xs leading-relaxed text-[#8b96aa]">
        Enter your email and we&apos;ll send a link to choose a new password.
      </p>

      {state?.ok && (
        <p className="mb-2.5 flex items-start gap-2 rounded-lg px-2.5 py-2 text-xs leading-relaxed"
           style={{ background: "rgba(52,211,153,0.12)", color: "#6ee7b7" }}>
          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {state.ok}
            {/* Only ever set outside production, when no provider is configured
                — the token is real, so the link still works for testing. */}
            {state.devLink && (
              <>
                {" "}
                <a href={state.devLink} className="underline underline-offset-2">
                  Open the link
                </a>{" "}
                <span className="opacity-70">(shown because email isn&apos;t configured)</span>
              </>
            )}
          </span>
        </p>
      )}

      {state?.error && (
        <p className="mb-2.5 flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs"
           style={{ background: "rgba(239,68,68,0.12)", color: "#fca5a5" }}>
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {state.error}
        </p>
      )}

      <div className="flex gap-2">
        <div className="auth-field-wrap flex-1">
          <Mail className="auth-field-icon pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#5b8dff]" />
          <input
            name="email"
            type="email"
            required
            placeholder="you@company.com"
            autoComplete="email"
            className="login-field !py-2.5 !pl-10 !text-sm"
          />
        </div>
        <button
          type="submit"
          disabled={pending}
          className="auth-submit shrink-0 rounded-xl px-4 text-sm font-semibold text-white disabled:opacity-60"
          style={{ backgroundImage: "linear-gradient(135deg,#3b82f6,#06b6d4)" }}
        >
          {pending ? "Sending…" : "Send"}
        </button>
      </div>
    </form>
  );
}
