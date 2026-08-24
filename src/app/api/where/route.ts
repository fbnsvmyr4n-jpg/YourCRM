import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * A coarse position for a browser that would not give us one.
 *
 * The middle rung of the login environment's location ladder. It reads the
 * coordinates the hosting platform already attaches to the request at its edge,
 * derived from the connecting IP — so **nothing is sent to a third party and no
 * lookup leaves this origin.** A commercial IP-geolocation service would mean
 * handing a visitor's address to somebody else before they have even signed in,
 * which is a poor trade for knowing roughly which continent to draw.
 *
 * Rounded to the same 0.1° as everything else, and rounded here rather than
 * only in the client: precision this endpoint never emits is precision that
 * cannot end up in an access log.
 *
 * Unauthenticated by design — it runs before sign-in, and it discloses nothing
 * the caller did not already tell us by connecting.
 */
export async function GET(request: Request) {
  const latitude = coarse(request.headers.get("x-vercel-ip-latitude"));
  const longitude = coarse(request.headers.get("x-vercel-ip-longitude"));

  if (latitude === null || longitude === null) {
    // Locally, and on any host that does not add these, there is simply no
    // answer. 404 rather than a guess: the client's ladder is built to move on
    // from nothing, and a fabricated position would be indistinguishable from a
    // real one at exactly the moment it matters.
    return NextResponse.json({ error: "no position for this request" }, { status: 404 });
  }

  return NextResponse.json(
    { latitude, longitude },
    // Never cached. The next visitor is a different IP, and a shared cache
    // serving them this position would be both wrong and a small leak.
    { headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * A header value as a coordinate, or null.
 *
 * `Number("")` is 0, which is a real place in the Atlantic — so an empty or
 * missing header would otherwise resolve to a confident, wrong position off the
 * coast of Africa. Emptiness is checked before the conversion, not after.
 */
function coarse(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  if (value < -180 || value > 180) return null;

  return Number(value.toFixed(1));
}
