"use client";

import { useActionState, useState } from "react";
import { AlertCircle, ArrowRight, Eye, EyeOff, Lock, Mail, ShieldCheck } from "lucide-react";
import { signInAction, type AuthState } from "@/app/(auth)/actions";
import { ConstellationField } from "@/components/login/ConstellationField";
import { NightScene } from "@/components/login/NightScene";
import { LoginCard } from "@/components/login/LoginCard";

export default function LoginPage() {
  const [showPw, setShowPw] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const [state, formAction, pending] = useActionState<AuthState, FormData>(signInAction, undefined);

  return (
    <main className="relative flex min-h-screen w-full items-center justify-center overflow-hidden px-4 py-12">
      {/* Environment: sky, mountains, then the live star field on top. */}
      <div className="login-scene" aria-hidden>
        <div className="login-milky" />
        <div className="login-stars" />
        <NightScene />
      </div>
      <ConstellationField />

      {/* Composition. The orbs and shards sit behind the panel at different
          depths so the form reads as suspended in the scene rather than
          stamped onto it. */}
      <div className="auth-stage">
        <span className="auth-orb a" aria-hidden />
        <span className="auth-orb b" aria-hidden />
        <span className="auth-orb c" aria-hidden />
        <span className="auth-shard one" aria-hidden />
        <span className="auth-shard two" aria-hidden />

        <div className="auth-enter">
          <LoginCard>
            {/* Brand */}
            <div className="flex flex-col items-center text-center">
              <svg
                width="42"
                height="42"
                viewBox="0 0 100 100"
                fill="none"
                className="auth-in"
                style={{ ["--d" as string]: "0.5s", filter: "drop-shadow(0 8px 26px rgba(56,132,255,0.6))" }}
              >
                <defs>
                  <linearGradient id="loginLogo" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#3b82f6" />
                    <stop offset="1" stopColor="#06b6d4" />
                  </linearGradient>
                </defs>
                <rect x="22" y="22" width="56" height="56" rx="16" transform="rotate(45 50 50)" fill="url(#loginLogo)" />
                <rect x="39" y="39" width="22" height="22" rx="6" transform="rotate(45 50 50)" fill="#0b0f16" />
              </svg>

              <h1
                className="auth-in mt-6 text-[2.1rem] font-semibold leading-none tracking-[-0.03em]"
                style={{ ["--d" as string]: "0.58s" }}
              >
                Welcome back
              </h1>
              <p
                className="auth-in mt-3 text-sm text-[#8b96aa]"
                style={{ ["--d" as string]: "0.66s" }}
              >
                Sign in to continue to YourCRM
              </p>
            </div>

            <form className="mt-9 space-y-4" action={formAction}>
              {state?.error && (
                <p
                  className="flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm"
                  style={{ background: "rgba(239,68,68,0.12)", color: "#fca5a5" }}
                >
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  {state.error}
                </p>
              )}

              <div className="auth-in auth-field-wrap" style={{ ["--d" as string]: "0.74s" }}>
                <Mail className="auth-field-icon pointer-events-none absolute left-4 top-1/2 h-[17px] w-[17px] -translate-y-1/2 text-[#5b8dff]" />
                <input
                  name="email"
                  type="email"
                  required
                  placeholder="Email address"
                  autoComplete="email"
                  className="login-field"
                />
              </div>

              <div className="auth-in auth-field-wrap" style={{ ["--d" as string]: "0.82s" }}>
                <Lock className="auth-field-icon pointer-events-none absolute left-4 top-1/2 h-[17px] w-[17px] -translate-y-1/2 text-[#5b8dff]" />
                <input
                  name="password"
                  type={showPw ? "text" : "password"}
                  required
                  placeholder="Password"
                  autoComplete="current-password"
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

              <div
                className="auth-in flex items-center justify-between pt-0.5 text-sm"
                style={{ ["--d" as string]: "0.9s" }}
              >
                <label className="flex cursor-pointer select-none items-center gap-2.5 text-[#8b96aa]">
                  <input type="checkbox" name="remember" value="1" defaultChecked className="login-chk" />
                  Keep me signed in
                </label>
                {/* Not a dead link: password reset needs email delivery, which
                    isn't configured, so this says so plainly instead of
                    pretending to start a flow that cannot finish. */}
                <button
                  type="button"
                  onClick={() => setShowReset((v) => !v)}
                  aria-expanded={showReset}
                  className="auth-link font-medium"
                >
                  Forgot password?
                </button>
              </div>

              <div className={`auth-note ${showReset ? "open" : ""}`} aria-hidden={!showReset}>
                <div>
                  <p className="rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-3 text-xs leading-relaxed text-[#8b96aa]">
                    Self-service reset isn&apos;t live yet — it needs an email provider
                    connected. Until then, an admin can set a new password for you from
                    <span className="text-[#b9c4d6]"> Settings → Password</span>.
                  </p>
                </div>
              </div>

              <button
                type="submit"
                disabled={pending}
                className="auth-in auth-submit mt-1 flex w-full items-center justify-center gap-2.5 rounded-2xl px-5 py-3.5 text-[0.95rem] font-semibold text-white disabled:opacity-70"
                style={{
                  ["--d" as string]: "0.98s",
                  backgroundImage: "linear-gradient(135deg,#3b82f6,#06b6d4)",
                  boxShadow: "0 14px 34px -10px rgba(56,132,255,0.6), inset 0 1px 0 rgba(255,255,255,0.35)",
                }}
              >
                {pending ? "Signing in…" : "Sign in"}
                {!pending && <ArrowRight className="h-[18px] w-[18px]" />}
              </button>

              {/* Alternative sign-in providers belong here in the hierarchy.
                  Deliberately absent until OAuth is actually wired: a dead
                  provider button on a login screen is the worst place to put
                  one, because people reach for it before the form. */}
            </form>

            <p className="auth-in mt-7 text-center text-sm text-[#8b96aa]" style={{ ["--d" as string]: "1.06s" }}>
              New to YourCRM?{" "}
              <a href="/signup" className="auth-link font-medium">
                Create an account
              </a>
            </p>
            <div
              className="auth-in mt-5 flex items-center justify-center gap-2 text-xs text-[#5b6577]"
              style={{ ["--d" as string]: "1.14s" }}
            >
              <ShieldCheck className="h-3.5 w-3.5 text-[#4a6ea8]" />
              Secure and encrypted
            </div>
          </LoginCard>
        </div>
      </div>
    </main>
  );
}
