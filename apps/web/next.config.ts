import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@word-hunt/shared", "@word-hunt/db"],
  outputFileTracingRoot: path.resolve(__dirname, "../..")
};

export default nextConfig;
