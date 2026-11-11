// @ts-check
/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
export default {
  wiki: [
    "index",
    { type: "category", label: "Get started", collapsed: false, items: [
      "getting-started/demo-kit",
      "getting-started/network-setup",
    ]},
    { type: "category", label: "Products", collapsed: false, items: [
      { type: "doc", id: "products/aura-one", className: "soon" },
      { type: "doc", id: "products/aura-lite", className: "soon" },
      "products/aura-tag",
      "products/aura-link",
      "products/aura-server",
    ]},
    { type: "category", label: "Demo Server", collapsed: false, items: [
      "aura-server/console",
      "aura-server/rest-api",
      "aura-server/live-feed",
      "aura-server/behaviours",
      "aura-server/webhooks",
    ]},
    { type: "category", label: "How it works", items: [
      "concepts/how-it-works",
      "concepts/location-and-proximity",
      "concepts/light-and-groups",
    ]},
    "faq",
  ],
};
