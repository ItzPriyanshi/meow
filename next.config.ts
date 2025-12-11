import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    const API_URL = process.env.API_URL || "http://localhost:3041";
    return [
      {
        source: "/api/:path*",
        destination: `${API_URL}/api/:path*`,
      },
      {
        source: "/yt",
        destination: `${API_URL}/yt`,
      },
      {
        source: "/stream/:path*",
        destination: `${API_URL}/stream/:path*`,
      },
      {
        source: "/pin",
        destination: `${API_URL}/pin`,
      },
       {
        source: "/insta",
        destination: `${API_URL}/insta`,
      },
       {
        source: "/instav2",
        destination: `${API_URL}/instav2`,
      },
       {
        source: "/fb",
        destination: `${API_URL}/fb`,
      },
       {
        source: "/tt",
        destination: `${API_URL}/tt`,
      },
       {
        source: "/x",
        destination: `${API_URL}/x`,
      },
    ];
  },
};

export default nextConfig;
