// @ts-check
import { themes as prismThemes } from "prism-react-renderer";

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: "Aetherfield Wiki",
  tagline: "Aura wearables, Aura Link gateways and Aura Server",
  favicon: "img/favicon.svg",
  // Served at aetherfield.ai/wiki: the main site rewrites /wiki/* to this
  // project. Override with WIKI_BASE_URL=/ to serve from a domain root.
  url: process.env.WIKI_URL || "https://aetherfield.ai",
  baseUrl: process.env.WIKI_BASE_URL || "/wiki/",
  onBrokenLinks: "throw",
  noIndex: true,            // private client docs: keep out of search engines
  trailingSlash: false,
  markdown: { hooks: { onBrokenMarkdownLinks: "throw" } },
  i18n: { defaultLocale: "en", locales: ["en"] },
  future: { v4: true },

  presets: [
    [
      "classic",
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          routeBasePath: "/",          // the wiki IS the docs
          sidebarPath: "./sidebars.js",
          editUrl: undefined,
          showLastUpdateTime: false,
        },
        blog: false,
        theme: { customCss: "./src/css/custom.css" },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      colorMode: { defaultMode: "dark", respectPrefersColorScheme: true },
      navbar: {
        title: "Aetherfield",
        logo: { alt: "Aetherfield", src: "img/logo.svg" },
        items: [
          { to: "/getting-started/demo-kit", label: "Get started", position: "left" },
          {
            type: "dropdown", label: "Products", position: "left",
            items: [
              { to: "/products/aura-one", label: "Aura One · coming soon", className: "soon" },
              { to: "/products/aura-lite", label: "Aura Lite · coming soon", className: "soon" },
              { to: "/products/aura-tag", label: "Aura Tag" },
              { to: "/products/aura-link", label: "Aura Link" },
              { to: "/products/aura-server", label: "Aura Server" },
            ],
          },
          { to: "/aura-server/rest-api", label: "API", position: "left" },
          // Aura Server runs on the client's own laptop. This page opens its
          // console if it's running there, and explains how to start it if not.
          { to: "/open-server", label: "Open Aura Server", position: "right", className: "local-server" },
          { href: "https://aetherfield.ai", label: "aetherfield.ai", position: "right" },
        ],
      },
      footer: {
        style: "dark",
        links: [
          { title: "Start", items: [
            { label: "Demo kit quick start", to: "/getting-started/demo-kit" },
            { label: "Network setup", to: "/getting-started/network-setup" },
          ]},
          { title: "Build on it", items: [
            { label: "REST API", to: "/aura-server/rest-api" },
            { label: "Live feed (WebSocket)", to: "/aura-server/live-feed" },
            { label: "Behaviours", to: "/aura-server/behaviours" },
          ]},
          { title: "Aetherfield", items: [
            { label: "aetherfield.ai", href: "https://aetherfield.ai" },
          ]},
        ],
        copyright: `© ${new Date().getFullYear()} Aetherfield`,
      },
      prism: { theme: prismThemes.github, darkTheme: prismThemes.dracula, additionalLanguages: ["bash", "json"] },
    }),
};

export default config;
