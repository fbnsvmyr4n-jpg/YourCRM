import { DEFAULT_LOCATION, validateCoordinates } from "./coordinates";
import type { Coordinates } from "./types";

/**
 * Where the user is, resolved without ever getting in their way.
 *
 * The rule this file exists to enforce is §7's last line: **location is an
 * enhancement, never a prerequisite for authentication.** So nothing here
 * throws, nothing here rejects, and nothing here can hang. Every path — denied,
 * unsupported, timed out, offline, or a browser returning nonsense — ends at a
 * usable coordinate, because the alternative is a sign-in form waiting on a
 * permission dialog the user has already dismissed.
 *
 * The ladder, in order: the browser's own geolocation, then a coarse position
 * derived from the request's IP, then a configured default.
 *
 * Dependencies are injected rather than reached for. `navigator` and `fetch`
 * are arguments with defaults, which is what lets the whole ladder — including
 * the denials and the timeouts — be tested in Node without a browser or a
 * network.
 */

/**
 * How long to wait for the browser before moving on.
 *
 * Six seconds. Long enough for a cold GPS fix on a phone, short enough that a
 * user who never sees the permission prompt is not staring at a default sky
 * while something invisible ticks. It is a ceiling, not a delay: a permission
 * already granted resolves in milliseconds.
 */
export const GEOLOCATION_TIMEOUT_MS = 6_000;

/** The same ceiling for the IP lookup, which is a same-origin request. */
export const IP_TIMEOUT_MS = 3_000;

type GeolocationLike = {
  getCurrentPosition(
    onSuccess: (position: { coords: { latitude: number; longitude: number } }) => void,
    onError: (error: unknown) => void,
    options?: { timeout?: number; maximumAge?: number; enableHighAccuracy?: boolean }
  ): void;
};

export type LocationDeps = {
  geolocation?: GeolocationLike | null;
  fetcher?: typeof fetch | null;
  /** Overridable so the timeout paths are testable without waiting six seconds. */
  timeoutMs?: number;
};

/**
 * Ask the browser where it is.
 *
 * Resolves to null on every failure rather than rejecting, so the caller reads
 * as a ladder instead of a stack of try/catch. The distinction between "denied"
 * and "unavailable" is deliberately not surfaced: both mean the same thing to
 * everything downstream, and a login screen has no business explaining the
 * difference to somebody trying to sign in.
 *
 * `enableHighAccuracy` is off and `maximumAge` is generous, per §7. A login
 * environment needs a stable location, not live movement tracking, and asking
 * for GPS-grade precision spins the radio for an answer that gets rounded to
 * 11 km anyway.
 */
async function fromBrowser(
  geolocation: GeolocationLike | null | undefined,
  timeoutMs: number
): Promise<Coordinates | null> {
  if (!geolocation) return null;

  return new Promise<Coordinates | null>((resolve) => {
    // Guarded against a callback that never fires *and* against one that fires
    // twice. The Geolocation API is old, its implementations vary, and a
    // promise settled twice is a bug that only shows up on one browser.
    let settled = false;
    const finish = (value: Coordinates | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    // Our own timer as well as the API's `timeout` option: the option is not
    // honoured uniformly, and a permission prompt the user simply ignores can
    // leave the callback pending indefinitely on some browsers.
    const timer = setTimeout(() => finish(null), timeoutMs);

    try {
      geolocation.getCurrentPosition(
        (position) => {
          clearTimeout(timer);
          // Validated rather than trusted. It arrives from an API, not from
          // our own code, and a browser extension or a spoofing tool can put
          // anything in it.
          finish(
            validateCoordinates(position?.coords?.latitude, position?.coords?.longitude, "gps")
          );
        },
        () => {
          clearTimeout(timer);
          finish(null);
        },
        { timeout: timeoutMs, maximumAge: 10 * 60_000, enableHighAccuracy: false }
      );
    } catch {
      // Some browsers throw synchronously on insecure origins rather than
      // calling the error callback.
      clearTimeout(timer);
      finish(null);
    }
  });
}

/**
 * A coarse position from the request's IP, read from our own origin.
 *
 * Same-origin, and the coordinates come from the hosting platform's own edge
 * headers rather than a third-party lookup service — so no address and no
 * position is sent anywhere, which is what §25 is asking for. If the platform
 * does not supply them, this returns null and the ladder moves on.
 */
async function fromIp(
  fetcher: typeof fetch | null | undefined,
  timeoutMs: number
): Promise<Coordinates | null> {
  if (!fetcher) return null;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetcher("/api/where", { signal: abort.signal });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return null;
    const { latitude, longitude } = body as { latitude?: unknown; longitude?: unknown };
    return validateCoordinates(latitude, longitude, "ip");
  } catch {
    // Offline, aborted, or a response that was not JSON. All the same here.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The full ladder. Always succeeds.
 *
 * The return type is `Coordinates`, not `Coordinates | null`, which is the
 * point: no caller has to handle a failure, so no caller can handle it badly.
 * `source` carries how the answer was reached, so the interface can decline to
 * present a default as though it were the user's actual location.
 */
export async function resolveLocation(deps: LocationDeps = {}): Promise<Coordinates> {
  const {
    geolocation = typeof navigator !== "undefined" ? navigator.geolocation : null,
    fetcher = typeof fetch !== "undefined" ? fetch : null,
    timeoutMs = GEOLOCATION_TIMEOUT_MS,
  } = deps;

  const gps = await fromBrowser(geolocation, timeoutMs);
  if (gps) return gps;

  const ip = await fromIp(fetcher, Math.min(timeoutMs, IP_TIMEOUT_MS));
  if (ip) return ip;

  return DEFAULT_LOCATION;
}
