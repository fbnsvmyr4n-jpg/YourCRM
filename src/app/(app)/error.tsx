"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, LogIn, RotateCw } from "lucide-react";

/**
 * Recovery UI for anything thrown while rendering a signed-in screen.
 *
 * Until this existed the app had **no** error boundary anywhere, so a throw
 * produced a blank segment with no way back. That became urgent the moment
 * `requireUser()` started throwing on an expired session: a user who left a tab
 * open overnight and clicked Delete got an unhandled error instead of "sign in
 * again". Every server action can now fail safely.
 *
 * Two paths are offered because there are two real causes. A session that
 * lapsed needs sign-in; a transient failure needs a retry. Guessing between
 * them client-side is unreliable — production masks the message behind a digest
 * — so both are offered rather than one being inferred wrongly.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Server-side logging carries the real cause; this records that the user
    // actually saw a failure, which the server log cannot know.
    console.error("[app] render failed", { digest: error.digest, message: error.message });
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-lg flex-col items-center justify-center px-6 text-center">
      <span
        className="mb-5 grid h-14 w-14 place-items-center rounded-2xl"
        style={{ background: "var(--amber-soft)" }}
      >
        <AlertTriangle className="h-7 w-7" style={{ color: "var(--amber)" }} />
      </span>

      <h1 className="text-xl font-semibold tracking-tight">Something went wrong on this screen</h1>
      <p className="mt-2 text-sm text-muted">
        Your data is safe — nothing was saved or changed. If you have been away a while your session
        may simply have expired.
      </p>

      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="btn-accent focus-ring flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold"
        >
          <RotateCw className="h-4 w-4" /> Try again
        </button>
        <Link
          href="/login"
          className="btn-soft focus-ring flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-medium"
        >
          <LogIn className="h-4 w-4" /> Sign in again
        </Link>
      </div>

      {error.digest && (
        <p className="mt-6 font-mono text-[11px] text-faint">Reference: {error.digest}</p>
      )}
    </div>
  );
}
