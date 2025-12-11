import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://localhost:3041/api/:path*",
      },
      {
        source: "/yt",
        destination: "http://localhost:3041/yt",
      },
      {
        source: "/stream/:path*",
        destination: "http://localhost:3041/stream/:path*",
      },
      {
        source: "/pin",
        destination: "http://localhost:3041/pin",
      },
       {
        source: "/insta",
        destination: "http://localhost:3041/insta",
      },
       {
        source: "/instav2",
        destination: "http://localhost:3041/instav2",
      },
       {
        source: "/fb",
        destination: "http://localhost:3041/fb",
      },
       {
        source: "/tt",
        destination: "http://localhost:3041/tt",
      },
       {
        source: "/x",
        destination: "http://localhost:3041/x",
      },
    ];
  },
};

export default nextConfig;
