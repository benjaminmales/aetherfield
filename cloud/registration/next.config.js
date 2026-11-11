/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The whole app lives under /aura-registration, so aetherfield.cloud can
  // later host other things at other paths without moving the QR URLs that
  // are already printed on Tags.
  basePath: "/aura-registration",
  async redirects() {
    return [
      { source: "/", destination: "/aura-registration", basePath: false, permanent: false },
    ];
  },
};

module.exports = nextConfig;
