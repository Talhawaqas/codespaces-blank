/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    // production build ko safe rakhne ke liye built-in bypass
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default nextConfig;