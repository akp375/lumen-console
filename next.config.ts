import type { NextConfig } from "next";
import { NAV_REDIRECTS } from "./src/lib/pages";

const nextConfig: NextConfig = {
  /* config options here */
  devIndicators: false, // hide the floating Next.js "N" badge in development
  // Old page addresses keep working. Temporary (307) redirects, so browsers don't cache them while the nav is still changing.
  async redirects() {
    return NAV_REDIRECTS.map((r) => ({ ...r, permanent: false }));
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
