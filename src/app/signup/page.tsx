"use client";

import { useActionState, useState } from "react";
import { AlertCircle, ArrowRight, Eye, EyeOff, Lock, Mail, ShieldCheck, User } from "lucide-react";
import { signUpAction, type AuthState } from "@/app/(auth)/actions";
import { BrandLockup, OrbitScene } from "@/components/login/OrbitScene";

export default function SignUpPage() {
  const [showPw, setShowPw] = useState(false);
  const [state, formAction, pending] = useActionState<AuthState, FormData>(signUpAction, undefined);

  return (
    <main className="relative flex min-h-screen w-full items-center justify-center overflow-hidden px-5 py-14">
      <OrbitScene />

      <div className="orbit-form">
        <div className="orbit-in flex justify-center" style={{ ["--d" as string]: "0.15s" }}>
          <BrandLockup />
        </div>

        <h1 className="orbit-in orbit-title mt-6" style={{ ["--d" as string]: "0.28s" }}>
          Create account
        </h1>
        <p className="orbit-in orbit-sub mt-3" style={{ ["--d" as string]: "0.36s" }}>
          Start managing your pipeline in minutes
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
            <input name="name" required placeholder="Full name" autoComplete="name" className="orbit-field" />
          </div>

          <div className="orbit-in orbit-field-wrap" style={{ ["--d" as string]: "0.54s" }}>
            <Mail className="orbit-icon h-[18px] w-[18px]" />
            <input
              name="email"
              type="email"
              required
              placeholder="Email address"
              autoComplete="email"
              className="orbit-field"
            />
          </div>

          <div className="orbit-in orbit-field-wrap" style={{ ["--d" as string]: "0.62s" }}>
            <Lock className="orbit-icon h-[18px] w-[18px]" />
            <input
              name="password"
              type={showPw ? "text" : "password"}
              required
              minLength={8}
              placeholder="Password — at least 8 characters"
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

          <button
            type="submit"
            disabled={pending}
            className="orbit-in orbit-submit focus-ring mt-5 flex items-center justify-center gap-2.5"
            style={{ ["--d" as string]: "0.7s" }}
          >
            {pending ? "Creating account…" : "Create Account"}
            {!pending && <ArrowRight className="h-[18px] w-[18px]" />}
          </button>
        </form>

        <div className="orbit-footer">
        <p className="orbit-in mt-6 text-[0.88rem] orbit-quiet-text" style={{ ["--d" as string]: "0.8s" }}>
          Already have an account?{" "}
          <a href="/login" className="orbit-quiet font-medium underline-offset-4 hover:underline">
            Log in
          </a>
        </p>

        <div
          className="orbit-in mt-4 flex items-center justify-center gap-2 text-[0.8rem] orbit-faint-text"
          style={{ ["--d" as string]: "0.88s" }}
        >
          <ShieldCheck className="h-3.5 w-3.5" />
          Secure. Private. Always.
        </div>
        </div>
      </div>
    </main>
  );
}
