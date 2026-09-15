import { headers } from "next/headers";

/**
 * The caller's IP, for rate limiting.
 *
 * Behind Vercel the socket address is always the proxy, so the real client
 * comes from `x-forwarded-for` — first entry, since downstream proxies append.
 * A spoofed header can only ever *shift* an attacker between IP buckets; it
 * can't help them past a limit keyed on something they cannot change.
 *
 * Lives here rather than in an actions file because every async export of a
 * `"use server"` module is a public POST endpoint. Sharing this from the sign-in
 * actions would have published "tell me my IP" as an action to the internet.
 */
export async function clientIp(): Promise<string> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return h.get("x-real-ip")?.trim() || "unknown";
}
