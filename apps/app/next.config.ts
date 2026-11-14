import { resolve } from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
  poweredByHeader: false,
  // Frame protection is set at runtime in src/proxy.ts (skipped in demo mode,
  // which the marketing site embeds in an iframe).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
    ];
  },
  turbopack: {
    root: resolve(import.meta.dirname, "../.."),
  },
};

export default nextConfig;
