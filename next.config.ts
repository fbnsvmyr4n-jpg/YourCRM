import type { NextConfig } from "next";

/**
 * The public pages a business is meant to put on its own website.
 *
 * Settings → Preferences hands out an `<iframe>` of the enquiry form, and a
 * booking page embeds the same way. Everything else refuses to be framed by
 * another site. Adding a public page does NOT make it embeddable — it has to be
 * named here, deliberately.
 */
export const EMBEDDABLE_PREFIXES = ["enquire", "book"] as const;

const nextConfig: NextConfig = {
  /**
   * Who may put this app inside a frame.
   *
   * Nobody else, for the app itself. Without this, any website could load a
   * signed-in screen in an invisible frame and line a harmless-looking button
   * up with "Delete contact" or "Approve quotation" — clickjacking. The session
   * cookie comes along with the framed request, so the click is the real user's.
   *
   * Two headers because browsers differ: `frame-ancestors` is the modern
   * control and `X-Frame-Options` covers anything older. The embeddable pages
   * get neither restriction, and say so explicitly.
   *
   * Next applies every matching rule, so the first rule EXCLUDES the embeddable
   * pages rather than relying on a later rule to undo it — `X-Frame-Options`
   * has no value meaning "anyone", so it could not be undone. Pinned by
   * `tests/frame-headers.test.ts`, run through Next's own path matcher.
   */
  async headers() {
    const except = EMBEDDABLE_PREFIXES.map((p) => `${p}/`).join("|");
    return [
      {
        source: `/:path((?!${except}).*)`,
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
        ],
      },
      {
        source: `/(${EMBEDDABLE_PREFIXES.join("|")})/:slug`,
        headers: [{ key: "Content-Security-Policy", value: "frame-ancestors *" }],
      },
    ];
  },

  // `pg` is a server-only driver that reaches for Node's networking modules.
  // Marking it external keeps it out of the client bundle entirely rather than
  // relying on resolver fallbacks to paper over it.
  serverExternalPackages: ["pg"],

  // The file-backed store (src/server/*) uses Node's `fs`/`path`, and `pg`
  // pulls in networking built-ins. All of this only ever executes server-side
  // (server components + server actions), but webpack still tries to resolve
  // the imports while tracing the client graph — map them to `false` there.
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve = config.resolve || {};
      config.resolve.fallback = {
        ...(config.resolve.fallback || {}),
        fs: false,
        path: false,
        net: false,
        tls: false,
        dns: false,
      };
    }
    return config;
  },
};

export default nextConfig;
