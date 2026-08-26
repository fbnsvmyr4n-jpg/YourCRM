"use client";

import Link from "next/link";

import { useActionState, useState } from "react";
import { AlertCircle, ArrowRight, Eye, EyeOff, Lock, ShieldCheck, User } from "lucide-react";
import { signInAction, type AuthState } from "@/app/(auth)/actions";
import { BrandLockup } from "@/components/login/OrbitScene";
import { ResetRequestForm } from "@/components/login/ResetRequestForm";

export default function LoginPage() {
  const [showPw, setShowPw] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const [oauthNote, setOauthNote] = useState<string | null>(null);
  const [state, formAction, pending] = useActionState<AuthState, FormData>(signInAction, undefined);

  return (

      <div className="orbit-form">
        <div className="orbit-in flex justify-center" style={{ ["--d" as string]: "0.15s" }}>
          <BrandLockup />
        </div>

        <h1 className="orbit-in orbit-title mt-6" style={{ ["--d" as string]: "0.28s" }}>
          Welcome back
        </h1>
        <p className="orbit-in orbit-sub mt-3" style={{ ["--d" as string]: "0.36s" }}>
          Sign in to continue your journey
        </p>

        <form className="mt-8 space-y-3.5" action={formAction}>
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
            <User className="orbit-icon h-[18px] w-[18px]" />
            <input
              name="email"
              type="email"
              required
              placeholder="Email address"
              autoComplete="email"
              className="orbit-field"
            />
          </div>

          <div className="orbit-in orbit-field-wrap" style={{ ["--d" as string]: "0.54s" }}>
            <Lock className="orbit-icon h-[18px] w-[18px]" />
            <input
              name="password"
              type={showPw ? "text" : "password"}
              required
              placeholder="Password"
              autoComplete="current-password"
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

          <button
            type="submit"
            disabled={pending}
            className="orbit-in orbit-submit focus-ring mt-5 flex items-center justify-center gap-2.5"
            style={{ ["--d" as string]: "0.62s" }}
          >
            {pending ? "Signing in…" : "Sign In"}
            {!pending && <ArrowRight className="h-[18px] w-[18px]" />}
          </button>

          {/* Kept from the working form rather than dropped for the look: this
              decides whether the session cookie outlives the browser, so
              removing the control would silently change how long someone stays
              signed in. Quiet enough to sit inside the composition. */}
          <label className="orbit-in mt-4 flex cursor-pointer select-none items-center justify-center gap-2.5 text-[0.82rem] orbit-quiet-text" style={{ ["--d" as string]: "0.68s" }}>
            <input type="checkbox" name="remember" value="1" defaultChecked className="login-chk" />
            Keep me signed in
          </label>
        </form>

        <button
          type="button"
          onClick={() => setShowReset((v) => !v)}
          aria-expanded={showReset}
          className="orbit-in orbit-quiet focus-ring mt-3 rounded-lg text-[0.88rem]"
          style={{ ["--d" as string]: "0.7s" }}
        >
          Forgot your password?
        </button>

        {/* Its own <form>, after the sign-in one — nesting forms is invalid and
            would stop sign-in submitting its own fields. */}
        <div className={`auth-note ${showReset ? "open" : ""}`} aria-hidden={!showReset}>
          <div className="pt-4">
            <ResetRequestForm />
          </div>
        </div>

        <div className="orbit-in orbit-divider mt-8" style={{ ["--d" as string]: "0.78s" }}>
          or continue with
        </div>

        {/* These providers are not connected yet. They say so when pressed
            rather than doing nothing — a login screen is the worst place for a
            control that looks live and isn't, because people reach for it
            before they reach for the form. */}
        <div className="orbit-in mt-4 flex items-center justify-center gap-4" style={{ ["--d" as string]: "0.86s" }}>
          <button
            type="button"
            onClick={() => setOauthNote("Apple sign-in isn't connected yet — use your email and password for now.")}
            className="orbit-oauth focus-ring"
            aria-label="Continue with Apple"
          >
            <svg viewBox="0 0 24 24" width="21" height="21" fill="currentColor" aria-hidden>
              <path d="M16.36 12.78c.02-2.2 1.8-3.26 1.88-3.31-1.02-1.5-2.62-1.7-3.18-1.72-1.35-.14-2.64.8-3.33.8-.69 0-1.75-.78-2.87-.76-1.48.02-2.84.86-3.6 2.18-1.54 2.67-.39 6.62 1.1 8.79.73 1.06 1.6 2.25 2.75 2.21 1.1-.05 1.52-.71 2.85-.71 1.33 0 1.71.71 2.87.69 1.19-.02 1.94-1.08 2.66-2.15.84-1.23 1.19-2.42 1.21-2.48-.03-.01-2.32-.89-2.34-3.54zM14.2 6.3c.61-.74 1.02-1.77.91-2.8-.88.04-1.94.59-2.57 1.32-.56.65-1.05 1.7-.92 2.7.98.08 1.98-.5 2.58-1.22z" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => setOauthNote("Google sign-in isn't connected yet — use your email and password for now.")}
            className="orbit-oauth focus-ring"
            aria-label="Continue with Google"
          >
            <svg viewBox="0 0 24 24" width="21" height="21" fill="currentColor" aria-hidden>
              <path d="M12.02 10.18v3.72h5.27c-.23 1.37-1.6 4.02-5.27 4.02-3.17 0-5.76-2.62-5.76-5.86s2.59-5.86 5.76-5.86c1.8 0 3.01.77 3.7 1.43l2.52-2.43C16.63 3.62 14.53 2.7 12.02 2.7 6.9 2.7 2.75 6.84 2.75 12s4.15 9.3 9.27 9.3c5.35 0 8.9-3.76 8.9-9.06 0-.61-.07-1.07-.15-1.53l-8.75-.03z" />
            </svg>
          </button>
        </div>

        {oauthNote && (
          <p className="mt-4 text-[0.82rem]" style={{ color: "#c7b48a" }} role="status">
            {oauthNote}
          </p>
        )}

        <div className="orbit-footer">
        <p className="orbit-in mt-6 text-[0.88rem] orbit-quiet-text" style={{ ["--d" as string]: "0.94s" }}>
          New to YourCRM?{" "}
          <Link href="/signup" className="orbit-quiet font-medium underline-offset-4 hover:underline">
            Create an account
          </Link>
        </p>

        <div
          className="orbit-in mt-4 flex items-center justify-center gap-2 text-[0.8rem] orbit-faint-text"
          style={{ ["--d" as string]: "1.02s" }}
        >
          <ShieldCheck className="h-3.5 w-3.5" />
          Secure. Private. Always.
        </div>
        </div>
      </div>
  );
}
