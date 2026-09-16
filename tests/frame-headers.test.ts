import { describe, expect, it } from "vitest";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import nextConfig, { EMBEDDABLE_PREFIXES } from "../next.config";

/**
 * Which pages another website may put in a frame.
 *
 * Checked through Next's OWN path matcher rather than by reading the patterns,
 * because the patterns are regular expressions inside route syntax and "looks
 * right" is exactly how a lookahead ends up matching nothing — which would
 * leave every signed-in screen frameable and no error anywhere.
 */

async function headersFor(pathname: string): Promise<Record<string, string>> {
  const rules = (await nextConfig.headers!()) ?? [];
  const out: Record<string, string> = {};
  for (const rule of rules) {
    const match = getPathMatch(rule.source, { removeUnnamedParams: true, strict: true });
    if (match(pathname) === false) continue;
    /* Next applies every matching rule, later ones overriding the same key. */
    for (const h of rule.headers) out[h.key] = h.value;
  }
  return out;
}

describe("the app refuses to be framed by other sites", () => {
  it.each([
    "/",
    "/login",
    "/contacts",
    "/deals",
    "/settings",
    "/projects/d-123",
    "/inbox",
    "/api/export/contacts",
    // Look-alikes of the embeddable prefixes are NOT embeddable.
    "/enquire",
    "/booking-help",
    "/bookings/abc",
  ])("%s", async (path) => {
    const h = await headersFor(path);
    expect(h["Content-Security-Policy"], `${path} can be framed by any site`).toBe("frame-ancestors 'self'");
    expect(h["X-Frame-Options"]).toBe("SAMEORIGIN");
  });
});

describe("the public pages a business embeds on its own website", () => {
  it.each(["/enquire/acme-cranes", "/book/acme-cranes"])("%s may be framed anywhere", async (path) => {
    const h = await headersFor(path);
    expect(h["Content-Security-Policy"]).toBe("frame-ancestors *");
    expect(h["X-Frame-Options"], `${path} would be blocked inside the customer's own site`).toBeUndefined();
  });

  it("covers the enquiry form Settings hands out as embed code", () => {
    expect(EMBEDDABLE_PREFIXES).toContain("enquire");
  });
});
