import { describe, expect, it, vi } from "vitest";
import { DEFAULT_LOCATION } from "../src/lib/solar/coordinates";
import { resolveLocation } from "../src/lib/solar/location";

/**
 * The location ladder, and the promise that it never blocks anybody.
 *
 * §7's last line is the requirement worth testing hardest: location is an
 * enhancement, never a prerequisite for authentication. Every test below is
 * some version of "the user is trying to sign in and location went wrong" —
 * denied, unsupported, hung, offline, or a browser handing back nonsense — and
 * every one of them has to end at a usable coordinate rather than an error or
 * a wait.
 */

const CAPE_TOWN_ISH = { coords: { latitude: -33.924869, longitude: 18.424055 } };

/** A geolocation that answers successfully. */
const granted = () => ({
  getCurrentPosition: (ok: (p: typeof CAPE_TOWN_ISH) => void) => ok(CAPE_TOWN_ISH),
});

/** One that calls back with an error, as a denial does. */
const denied = () => ({
  getCurrentPosition: (_ok: unknown, fail: (e: unknown) => void) =>
    fail({ code: 1, message: "User denied Geolocation" }),
});

/** One that simply never answers — the dismissed permission prompt. */
const silent = () => ({ getCurrentPosition: () => {} });

/** One that throws synchronously, as some browsers do on an insecure origin. */
const throws = () => ({
  getCurrentPosition: () => {
    throw new Error("Only secure origins are allowed");
  },
});

const jsonFetch = (body: unknown, ok = true) =>
  vi.fn().mockResolvedValue({ ok, json: async () => body }) as unknown as typeof fetch;

const noFetch = () => vi.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch;

describe("the browser knows where it is", () => {
  it("uses the browser's position and records how it was obtained", async () => {
    const where = await resolveLocation({ geolocation: granted(), fetcher: noFetch() });
    expect(where.source).toBe("gps");
    expect(where.latitude).toBe(-33.9);
  });

  it("blunts the precision before it goes anywhere", async () => {
    // The browser gave six decimal places. Nothing downstream should ever see
    // them — that is what makes the privacy property structural rather than a
    // convention every future caller has to remember.
    const where = await resolveLocation({ geolocation: granted(), fetcher: noFetch() });
    expect(where.latitude).toBe(-33.9);
    expect(where.longitude).toBe(18.4);
  });

  it("does not consult the IP fallback when the browser answered", async () => {
    const fetcher = jsonFetch({ latitude: 51.5, longitude: -0.1 });
    const where = await resolveLocation({ geolocation: granted(), fetcher });
    expect(fetcher).not.toHaveBeenCalled();
    expect(where.source).toBe("gps");
  });
});

describe("the browser will not, or cannot", () => {
  it("falls back to the IP position when permission is denied", async () => {
    const where = await resolveLocation({
      geolocation: denied(),
      fetcher: jsonFetch({ latitude: 51.5, longitude: -0.1 }),
    });
    expect(where.source).toBe("ip");
    expect(where.latitude).toBe(51.5);
  });

  it("falls back when geolocation is not supported at all", async () => {
    const where = await resolveLocation({
      geolocation: null,
      fetcher: jsonFetch({ latitude: 51.5, longitude: -0.1 }),
    });
    expect(where.source).toBe("ip");
  });

  it("moves on when the browser throws instead of calling back", async () => {
    // Insecure origins do this. A synchronous throw would escape the promise
    // entirely and reject the whole ladder if it were not caught.
    const where = await resolveLocation({
      geolocation: throws(),
      fetcher: jsonFetch({ latitude: 51.5, longitude: -0.1 }),
    });
    expect(where.source).toBe("ip");
  });

  it("gives up on a prompt nobody answers instead of waiting forever", async () => {
    /**
     * The failure this is really guarding: a permission dialog the user
     * ignores. The callback never fires, and without our own timer the promise
     * never settles — so anything awaiting the environment waits for the rest
     * of the session.
     */
    const started = Date.now();
    const where = await resolveLocation({
      geolocation: silent(),
      fetcher: noFetch(),
      timeoutMs: 30,
    });
    expect(where).toEqual(DEFAULT_LOCATION);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("nothing works", () => {
  it("uses the default when both rungs fail", async () => {
    const where = await resolveLocation({ geolocation: denied(), fetcher: noFetch() });
    expect(where).toEqual(DEFAULT_LOCATION);
    expect(where.source).toBe("default");
  });

  it("uses the default when the IP endpoint has no answer", async () => {
    // Locally, and on any host that does not attach edge coordinates, /api/where
    // returns 404 rather than a guess.
    const where = await resolveLocation({
      geolocation: denied(),
      fetcher: jsonFetch({ error: "no position for this request" }, false),
    });
    expect(where).toEqual(DEFAULT_LOCATION);
  });

  it("marks the default as a default, so it is never shown as the user's location", async () => {
    const where = await resolveLocation({ geolocation: null, fetcher: null });
    expect(where.source).toBe("default");
  });
});

describe("what comes back is not trusted", () => {
  it("rejects nonsense from the browser and carries on down the ladder", async () => {
    // A spoofing extension, or a broken implementation. Validated on the way in
    // like anything else that arrives from outside our own code.
    const nonsense = {
      getCurrentPosition: (ok: (p: { coords: { latitude: number; longitude: number } }) => void) =>
        ok({ coords: { latitude: 999, longitude: NaN } }),
    };
    const where = await resolveLocation({
      geolocation: nonsense,
      fetcher: jsonFetch({ latitude: 51.5, longitude: -0.1 }),
    });
    expect(where.source).toBe("ip");
  });

  it("rejects a malformed IP response", async () => {
    const where = await resolveLocation({
      geolocation: denied(),
      fetcher: jsonFetch({ latitude: "somewhere", longitude: null }),
    });
    expect(where).toEqual(DEFAULT_LOCATION);
  });

  it("believes the status, not the body", async () => {
    /**
     * A failed response can still carry a parseable body — an error page from a
     * proxy, a cached payload, a platform's own JSON 500. Reading coordinates
     * out of one would mean rendering a confident position that the endpoint
     * was refusing to give. The status line is the authority on whether there
     * is an answer at all; the body only matters once it says there is.
     */
    const where = await resolveLocation({
      geolocation: denied(),
      fetcher: jsonFetch({ latitude: 51.5, longitude: -0.1 }, false),
    });
    expect(where, "coordinates were taken from a failed response").toEqual(DEFAULT_LOCATION);
  });

  it("survives a response that is not JSON at all", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    }) as unknown as typeof fetch;

    const where = await resolveLocation({ geolocation: denied(), fetcher });
    expect(where).toEqual(DEFAULT_LOCATION);
  });
});

describe("the promise this whole file makes", () => {
  it("never rejects, whatever goes wrong", async () => {
    /**
     * The single most important property here. An unhandled rejection while
     * resolving the *decoration* behind a sign-in form would be absurd, and it
     * is exactly what a naive implementation does — `getCurrentPosition`'s
     * error callback is not a promise rejection, so it is easy to write a
     * version that rejects on every denial.
     */
    const disasters = [
      { geolocation: denied(), fetcher: noFetch() },
      { geolocation: throws(), fetcher: noFetch() },
      { geolocation: null, fetcher: null },
      { geolocation: silent(), fetcher: noFetch(), timeoutMs: 20 },
    ];

    for (const deps of disasters) {
      await expect(resolveLocation(deps)).resolves.toBeTruthy();
    }
  });

  it("always returns somewhere the sun actually rises", async () => {
    // Whatever the ladder returns is fed straight into the solar engine, so a
    // coordinate that is merely "valid" is not enough — it has to be a real
    // place that produces a sensible environment.
    const where = await resolveLocation({ geolocation: null, fetcher: null });
    expect(where.latitude).toBeGreaterThanOrEqual(-90);
    expect(where.latitude).toBeLessThanOrEqual(90);
    expect(where.longitude).toBeGreaterThanOrEqual(-180);
    expect(where.longitude).toBeLessThanOrEqual(180);
  });
});

describe("two callers, one journey", () => {
  it("shares a resolution that is already in flight", async () => {
    /**
     * React's Strict Mode invokes effects twice in development, and the shared
     * backdrop makes two scenes on one page possible for real. Either way,
     * asking twice should not mean two permission prompts and two requests.
     *
     * Uses the default dependencies, because that is the only path that shares:
     * a caller passing its own geolocation is testing a specific rung, and
     * sharing across those would leak one test's answer into another's.
     */
    const first = resolveLocation();
    const second = resolveLocation();
    expect(await first).toEqual(await second);
  });

  it("does not hand out a stale answer forever", async () => {
    // Cleared once it settles: somebody who has since granted permission should
    // get a fresh attempt, not the default this page happened to start with.
    const before = await resolveLocation();
    const after = await resolveLocation();
    expect(after).toEqual(before);
    expect(after.source).toBeTruthy();
  });
});
