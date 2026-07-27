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
        {/* Brand */}
        <div className="flex flex-col items-center text-center">
          <svg
            width="64"
            height="64"
            viewBox="0 0 100 100"
            fill="none"
            style={{ filter: "drop-shadow(0 6px 22px rgba(56,132,255,0.5))" }}
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
          <h1 className="mt-3 text-4xl font-bold tracking-tight">
            Your
            <span
              style={{
                backgroundImage: "linear-gradient(135deg,#60a5fa,#22d3ee)",
                WebkitBackgroundClip: "text",
                backgroundClip: "text",
                color: "transparent",
              }}
            >
              CRM
            </span>
          </h1>
          <p className="mt-1.5 text-sm tracking-wide text-[#9aa5b8]">Grow. Manage. Close.</p>

          <h2 className="mt-8 text-2xl font-semibold">Welcome back 👋</h2>
          <p className="mt-1.5 text-sm text-[#9aa5b8]">Sign in to continue to your account</p>
        </div>

        {/* Form */}
        <form className="mt-8 space-y-5" action={formAction}>
          {state?.error && (
            <p
              className="flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm"
              style={{ background: "rgba(239,68,68,0.12)", color: "#fca5a5" }}
            >
              <AlertCircle className="h-4 w-4 shrink-0" />
              {state.error}
            </p>
          )}
          <div>
            <label className="mb-2 block text-sm font-medium">Email address</label>
            <div className="relative">
              <Mail className="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-[#5b8dff]" />
              <input name="email" type="email" required placeholder="Enter your email" autoComplete="email" className="login-field" />
            </div>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium">Password</label>
            <div className="relative">
              <Lock className="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-[#5b8dff]" />
              <input
                name="password"
                type={showPw ? "text" : "password"}
                required
                placeholder="Enter your password"
                autoComplete="current-password"
                className="login-field"
              />
              <button
                type="button"
                onClick={() => setShowPw((v) => !v)}
                aria-label={showPw ? "Hide password" : "Show password"}
                className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-[#7c869a] transition-colors hover:text-[#5b8dff]"
              >
                {showPw ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
              </button>
            </div>
          </div>

          {/* "Forgot password?" was here, pointing at "#". A real reset needs
              email delivery, which isn't configured — so rather than a link
              that goes nowhere, it returns with the flow that backs it. */}
          <div className="flex items-center justify-between text-sm">
            <label className="flex cursor-pointer select-none items-center gap-2 text-[#9aa5b8]">
              <input type="checkbox" name="remember" value="1" defaultChecked className="login-chk" />
              Keep me signed in
            </label>
          </div>

          <button
            type="submit"
            disabled={pending}
            className="flex w-full items-center justify-center gap-2.5 rounded-2xl px-5 py-3.5 text-base font-semibold text-white transition-transform active:translate-y-px disabled:opacity-70"
            style={{
              backgroundImage: "linear-gradient(135deg,#3b82f6,#06b6d4)",
              boxShadow: "0 14px 34px -10px rgba(56,132,255,0.6), inset 0 1px 0 rgba(255,255,255,0.35)",
            }}
          >
            {pending ? "Signing in…" : "Log In"}
            {!pending && <ArrowRight className="h-5 w-5" />}
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

        <p className="mt-6 text-center text-sm text-[#9aa5b8]">
          Don&apos;t have an account?{" "}
          <a href="/signup" className="font-medium text-[#5b8dff] hover:text-[#7aa5ff]">
            Sign up
          </a>
        </p>
        <div className="mt-5 flex items-center justify-center gap-2 text-xs text-[#6b7688]">
          <ShieldCheck className="h-4 w-4 text-[#5b8dff]" />
          Your data is secure and encrypted
        </div>
      </LoginCard>
    </main>
  );
}

