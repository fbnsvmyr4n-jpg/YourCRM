"use client";

import Link from "next/link";

import { useActionState, useState } from "react";
import { AlertCircle, ArrowRight, Check, Eye, EyeOff, Lock, ShieldCheck } from "lucide-react";
import { resetPasswordAction, type ResetState } from "@/app/(auth)/reset-actions";
import { BrandLockup } from "@/components/login/OrbitScene";

export function ResetPasswordView({
  token,
  email,
  valid,
}: {
  token: string;
  email: string | null;
  valid: boolean;
}) {
  const [showPw, setShowPw] = useState(false);
  const [state, action, pending] = useActionState<ResetState, FormData>(resetPasswordAction, undefined);
  const done = !!state?.ok;

  return (

      <div className="orbit-form">
        <div className="orbit-in flex justify-center" style={{ ["--d" as string]: "0.15s" }}>
          <BrandLockup />
        </div>

        <h1 className="orbit-in orbit-title mt-6" style={{ ["--d" as string]: "0.28s" }}>
          {done ? "All set" : valid ? "New password" : "Link expired"}
        </h1>
        <p className="orbit-in orbit-sub mt-3" style={{ ["--d" as string]: "0.36s" }}>
          {done
            ? "Your password has been changed."
            : valid
              ? (email ?? "Choose a new password")
              : "This link has expired or has already been used."}
        </p>

        {done ? (
          <Link
            href="/login"
            className="orbit-in orbit-submit focus-ring mt-9 flex items-center justify-center gap-2.5"
            style={{ ["--d" as string]: "0.46s" }}
          >
            <Check className="h-[18px] w-[18px]" /> Sign In
          </Link>
        ) : !valid ? (
          <Link
            href="/login"
            className="orbit-in orbit-quiet focus-ring mt-9 inline-block rounded-lg text-[0.9rem] font-medium"
            style={{ ["--d" as string]: "0.46s" }}
          >
            Request a new link
          </Link>
        ) : (
          <form className="mt-8 space-y-3.5" action={action}>
            <input type="hidden" name="token" value={token} />

            {state?.error && (
              <p
                className="flex items-center gap-2 rounded-2xl px-4 py-3 text-left text-sm"
                style={{ background: "rgba(239,68,68,0.12)", color: "#fca5a5" }}
              >
                <AlertCircle className="h-4 w-4 shrink-0" />
                {state.error}
              </p>
            )}

            <div className="orbit-in orbit-field-wrap" style={{ ["--d" as string]: "0.46s" }}>
              <Lock className="orbit-icon h-[18px] w-[18px]" />
              <input
                name="password"
                type={showPw ? "text" : "password"}
                required
                minLength={8}
                placeholder="New password"
                autoComplete="new-password"
                className="orbit-field"
              />
              <button
                type="button"
                onClick={() => setShowPw((v) => !v)}
                aria-label={showPw ? "Hide password" : "Show password"}
                className="orbit-eye focus-ring rounded-full p-1"
              >
                {showPw ? <EyeOff className="h-[18px] w-[18px]" /> : <Eye className="h-[18px] w-[18px]" />}
              </button>
            </div>

            <div className="orbit-in orbit-field-wrap" style={{ ["--d" as string]: "0.54s" }}>
              <Lock className="orbit-icon h-[18px] w-[18px]" />
              <input
                name="confirm"
                type={showPw ? "text" : "password"}
                required
                minLength={8}
                placeholder="Confirm new password"
                autoComplete="new-password"
                className="orbit-field"
              />
            </div>

            <button
              type="submit"
              disabled={pending}
              className="orbit-in orbit-submit focus-ring mt-5 flex items-center justify-center gap-2.5"
              style={{ ["--d" as string]: "0.62s" }}
            >
              {pending ? "Updating…" : "Update password"}
              {!pending && <ArrowRight className="h-[18px] w-[18px]" />}
            </button>
          </form>
        )}

        <div
          className="orbit-footer orbit-in mt-8 flex items-center justify-center gap-2 text-[0.8rem] orbit-faint-text"
          style={{ ["--d" as string]: "0.8s" }}
        >
          <ShieldCheck className="h-3.5 w-3.5" />
          Secure. Private. Always.
        </div>
      </div>
  );
}
