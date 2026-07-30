import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [{ protocol: "https", hostname: "pics.dmm.co.jp" }],
  },
};

export default nextConfig;
