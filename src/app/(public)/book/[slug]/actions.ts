"use server";

import { bookingKey, checkRate, registerAttempt } from "@/server/repos/auth";
import { book } from "@/server/booking/book";
import { clientIp } from "@/server/client-ip";
import { withSystem } from "@/server/tenant";

/**
 * The one server action in this product that a stranger is meant to reach.
 *
 * Listed in `PUBLIC_ACTIONS` in the authorisation suite, with the reason. What
 * stands in for a session is, in order: a per-address rate limit that refuses
 * before any work is done, a slug that only resolves when the owner has
 * published it, and a posted time that is re-checked against the diary under a
 * lock. See `server/booking/book.ts`.
 */

export type BookState =
  | { ok: true; startsAt: string; workspaceName: string }
  | { ok: false; error: string; taken?: boolean; startsAt?: string }
  | undefined;

export async function bookAction(_prev: BookState, formData: FormData): Promise<BookState> {
  const keys = [bookingKey(await clientIp())];

  const verdict = await withSystem((q) => checkRate(q, keys));
  if (!verdict.allowed) {
    const mins = Math.max(1, Math.ceil(verdict.retryAfterSec / 60));
    return {
      ok: false,
      error: `Too many booking attempts from this connection. Please try again in ${mins} minute${mins === 1 ? "" : "s"}.`,
    };
  }
  /* Counted before the booking runs, success or not: the abuse on a public
     write is volume, and a counter that only moved on failure would let
     somebody fill a diary with successful bookings. */
  await withSystem((q) => registerAttempt(q, keys));

  const slug = String(formData.get("slug") ?? "");
  const startsAt = String(formData.get("startsAt") ?? "");
  const outcome = await book({
    slug,
    name: String(formData.get("name") ?? ""),
    email: String(formData.get("email") ?? ""),
    startsAt,
    notes: String(formData.get("notes") ?? ""),
  });

  if (outcome.ok) {
    return { ok: true, startsAt: outcome.startsAt, workspaceName: outcome.workspaceName };
  }
  /* The refused time goes back with the refusal, so the page can deselect
     exactly that slot without keeping state of its own about what failed. */
  return { ok: false, error: outcome.detail, taken: outcome.reason === "taken", startsAt };
}
