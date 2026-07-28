"use client";

import { useActionState, useState } from "react";
import { AlertCircle, ArrowRight, Eye, EyeOff, Lock, Mail, ShieldCheck } from "lucide-react";
import { signInAction, type AuthState } from "@/app/(auth)/actions";
import { ConstellationField } from "@/components/login/ConstellationField";
import { LoginCard } from "@/components/login/LoginCard";

export default function LoginPage() {
  const [showPw, setShowPw] = useState(false);
  const [state, formAction, pending] = useActionState<AuthState, FormData>(signInAction, undefined);

  return (
    <main className="relative flex min-h-screen w-full items-center justify-center px-4 py-10">
      {/* Cinematic scene */}
      <div className="login-scene" aria-hidden>
        <div className="login-milky" />
        <div className="login-stars" />
        <svg
          className="absolute bottom-0 left-0 right-0"
          style={{ height: "58vh" }}
          viewBox="0 0 1440 500"
          preserveAspectRatio="xMidYMax slice"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M0,500 L0,300 L180,150 L320,260 L470,120 L640,300 L760,200 L920,330 L1080,180 L1240,300 L1440,220 L1440,500 Z" fill="#0a1120" />
          <path d="M0,500 L0,360 L220,240 L400,340 L560,250 L760,380 L980,290 L1200,390 L1440,320 L1440,500 Z" fill="#080d18" />
          <path d="M0,500 L0,430 L260,360 L520,430 L820,370 L1120,440 L1440,390 L1440,500 Z" fill="#05080f" />
        </svg>
      </div>

      {/* Interactive layer — drifts on its own, reacts to the cursor. */}
      <ConstellationField />

      {/* Card */}
      <LoginCard>
        {/* Brand. Each block sets its own --d so the entrance reads as one
            continuous movement rather than several things arriving at once. */}
        <div className="flex flex-col items-center text-center">
          <svg
            width="46"
            height="46"
            viewBox="0 0 100 100"
            fill="none"
            className="auth-in"
            style={{ ["--d" as string]: "0.05s", filter: "drop-shadow(0 8px 26px rgba(56,132,255,0.55))" }}
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
            className="auth-in mt-7 text-[2.6rem] font-semibold leading-none tracking-[-0.03em]"
            style={{ ["--d" as string]: "0.14s" }}
          >
            Welcome back
          </h1>
          <p
            className="auth-in mt-3.5 text-[0.95rem] text-[#8792a6]"
            style={{ ["--d" as string]: "0.22s" }}
          >
            Sign in to continue to YourCRM
          </p>
        </div>

        {/* Form */}
        <form className="mt-11 space-y-7" action={formAction}>
          {state?.error && (
            <p
              className="flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm"
              style={{ background: "rgba(239,68,68,0.12)", color: "#fca5a5" }}
            >
              <AlertCircle className="h-4 w-4 shrink-0" />
              {state.error}
            </p>
          )}
          {/* No boxes — each field is a rule that lights up on focus. The
              label is gone; the placeholder carries it, which is the whole
              point of the minimal treatment. */}
          <div className="auth-in field-line" style={{ ["--d" as string]: "0.3s" }}>
            <Mail className="pointer-events-none absolute left-0 top-1/2 h-[17px] w-[17px] -translate-y-1/2 text-[#5b8dff]" />
            <input name="email" type="email" required placeholder="Email address" autoComplete="email" className="login-field" />
          </div>

          <div className="auth-in field-line" style={{ ["--d" as string]: "0.38s" }}>
            <Lock className="pointer-events-none absolute left-0 top-1/2 h-[17px] w-[17px] -translate-y-1/2 text-[#5b8dff]" />
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
              className="absolute right-0 top-1/2 -translate-y-1/2 p-1 text-[#6f7a8d] transition-colors hover:text-[#5b8dff]"
            >
              {showPw ? <EyeOff className="h-[18px] w-[18px]" /> : <Eye className="h-[18px] w-[18px]" />}
            </button>
          </div>

          {/* "Forgot password?" was here, pointing at "#". A real reset needs
              email delivery, which isn't configured — so rather than a link
              that goes nowhere, it returns with the flow that backs it. */}
          <div className="auth-in flex items-center justify-between text-sm" style={{ ["--d" as string]: "0.46s" }}>
            <label className="flex cursor-pointer select-none items-center gap-2.5 text-[#8792a6]">
              <input type="checkbox" name="remember" value="1" defaultChecked className="login-chk" />
              Keep me signed in
            </label>
          </div>

          <button
            type="submit"
            disabled={pending}
            className="auth-in auth-submit flex w-full items-center justify-center gap-2.5 rounded-full px-5 py-3.5 text-[0.95rem] font-semibold text-white disabled:opacity-70"
            style={{
              ["--d" as string]: "0.54s",
              backgroundImage: "linear-gradient(135deg,#3b82f6,#06b6d4)",
              boxShadow: "0 14px 34px -10px rgba(56,132,255,0.6), inset 0 1px 0 rgba(255,255,255,0.35)",
            }}
          >
            {pending ? "Signing in…" : "Sign in"}
            {!pending && <ArrowRight className="h-[18px] w-[18px]" />}
          </button>

          {/* The demo credentials were printed here. Fine while this ran on
              localhost; not once it is deployed on a public URL, where it
              hands anyone who finds the page a working login. The seeded
              account still exists — its password is just no longer published. */}

          {/* "Continue with Google" was here. It was decorative — there is no
              OAuth client configured, so clicking it did nothing. A dead
              sign-in button on a login screen is the worst place to leave one:
              people will try it before the form. It comes back when real
              Google OAuth is wired up, not before. */}
        </form>

        <p className="auth-in mt-9 text-center text-sm text-[#8792a6]" style={{ ["--d" as string]: "0.62s" }}>
          Don&apos;t have an account?{" "}
          <a href="/signup" className="font-medium text-[#5b8dff] transition-colors hover:text-[#8ab4ff]">
            Sign up
          </a>
        </p>
        <div
          className="auth-in mt-6 flex items-center justify-center gap-2 text-xs text-[#5b6577]"
          style={{ ["--d" as string]: "0.7s" }}
        >
          <ShieldCheck className="h-3.5 w-3.5 text-[#4a6ea8]" />
          Secure and encrypted
        </div>
      </LoginCard>
    </main>
  );
}

