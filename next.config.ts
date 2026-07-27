import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
