"use client";

import { useActionState, useState } from "react";
import { AlertCircle, ArrowRight, Check, Eye, EyeOff, Lock } from "lucide-react";
import { resetPasswordAction, type ResetState } from "@/app/(auth)/reset-actions";
import { ConstellationField } from "@/components/login/ConstellationField";
import { LoginCard } from "@/components/login/LoginCard";
import { NightScene } from "@/components/login/NightScene";

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
    <main className="relative flex min-h-screen w-full items-center justify-center overflow-hidden px-4 py-12">
      <div className="login-scene" aria-hidden>
        <div className="login-milky" />
        <div className="login-stars" />
        <NightScene />
      </div>
      <ConstellationField />

      <div className="auth-stage">
        <span className="auth-orb a" aria-hidden />
        <span className="auth-orb b" aria-hidden />
        <span className="auth-shard one" aria-hidden />

        <div className="auth-enter">
          <LoginCard>
            <div className="flex flex-col items-center text-center">
              <h1 className="auth-in text-[2.1rem] font-light leading-none tracking-[-0.04em]" style={{ ["--d" as string]: "0.5s" }}>
                {done ? "All set" : valid ? "New password" : "Link expired"}
              </h1>
              <p className="auth-in mt-3.5 text-sm text-[#8b96aa]" style={{ ["--d" as string]: "0.58s" }}>
                {done
                  ? "Your password has been changed."
                  : valid
                    ? email ?? "Choose a new password"
                    : "This link has expired or has already been used."}
              </p>
            </div>

            {done ? (
              <a
                href="/login"
                className="auth-in auth-submit mt-9 flex w-full items-center justify-center gap-2.5 rounded-2xl px-5 py-3.5 text-[0.95rem] font-semibold text-white"
                style={{
                  ["--d" as string]: "0.66s",
                  backgroundImage: "linear-gradient(135deg,#3b82f6,#06b6d4)",
                  boxShadow: "0 14px 34px -10px rgba(56,132,255,0.6), inset 0 1px 0 rgba(255,255,255,0.35)",
                }}
              >
                <Check className="h-[18px] w-[18px]" /> Sign in
              </a>
            ) : !valid ? (
              <a
                href="/login"
                className="auth-in mt-9 block text-center text-sm font-medium text-[#8ab4ff] transition-colors hover:text-[#b3d0ff]"
                style={{ ["--d" as string]: "0.66s" }}
              >
                Request a new link
              </a>
            ) : (
              <form className="mt-8 space-y-4" action={action}>
                <input type="hidden" name="token" value={token} />

                {state?.error && (
                  <p
                    className="flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm"
                    style={{ background: "rgba(239,68,68,0.12)", color: "#fca5a5" }}
                  >
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    {state.error}
                  </p>
                )}

                <div className="auth-in auth-field-wrap" style={{ ["--d" as string]: "0.66s" }}>
                  <Lock className="auth-field-icon pointer-events-none absolute left-4 top-1/2 h-[17px] w-[17px] -translate-y-1/2 text-[#5b8dff]" />
                  <input
                    name="password"
                    type={showPw ? "text" : "password"}
                    required
                    minLength={8}
                    placeholder="New password"
                    autoComplete="new-password"
                    className="login-field"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw((v) => !v)}
                    aria-label={showPw ? "Hide password" : "Show password"}
                    className="absolute right-3.5 top-1/2 -translate-y-1/2 p-1 text-[#6f7a8d] transition-colors hover:text-[#8ab8ff]"
                  >
                    {showPw ? <EyeOff className="h-[18px] w-[18px]" /> : <Eye className="h-[18px] w-[18px]" />}
                  </button>
                </div>

                <div className="auth-in auth-field-wrap" style={{ ["--d" as string]: "0.74s" }}>
                  <Lock className="auth-field-icon pointer-events-none absolute left-4 top-1/2 h-[17px] w-[17px] -translate-y-1/2 text-[#5b8dff]" />
                  <input
                    name="confirm"
                    type={showPw ? "text" : "password"}
                    required
                    minLength={8}
                    placeholder="Confirm new password"
                    autoComplete="new-password"
                    className="login-field"
                  />
                </div>

                <button
                  type="submit"
                  disabled={pending}
                  className="auth-in auth-submit mt-1 flex w-full items-center justify-center gap-2.5 rounded-2xl px-5 py-3.5 text-[0.95rem] font-semibold text-white disabled:opacity-70"
                  style={{
                    ["--d" as string]: "0.82s",
                    backgroundImage: "linear-gradient(135deg,#3b82f6,#06b6d4)",
                    boxShadow: "0 14px 34px -10px rgba(56,132,255,0.6), inset 0 1px 0 rgba(255,255,255,0.35)",
                  }}
                >
                  {pending ? "Updating…" : "Update password"}
                  {!pending && <ArrowRight className="h-[18px] w-[18px]" />}
                </button>
              </form>
            )}
          </LoginCard>
        </div>
      </div>
    </main>
  );
}
