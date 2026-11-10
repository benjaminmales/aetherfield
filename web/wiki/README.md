# Aetherfield Wiki

Client-facing documentation, built with [Docusaurus](https://docusaurus.io)
(the same engine as Seeed's wiki). Lives at **aetherfield.ai/wiki**, behind a
shared password.

```bash
npm install
npm start          # live preview at http://localhost:3000/wiki/ (no password locally)
npm run build      # static site in build/wiki/
```

Pages are Markdown in `docs/`; the left menu is `sidebars.js`. A broken
internal link fails the build on purpose.

## House rules

- **Never state an unmeasured figure.** Range, battery life, sync accuracy and
  capacity read "not yet measured" until there's a measurement behind them.
- API pages must match `server/lib/rest-v1.js` and `live-api.js`. If you change
  the API, change the page in the same commit.
- Aura devices do three things: receive commands, detect motion, report id +
  status. Don't document inputs the products don't have.

## Deploy (Vercel)

### 1. The wiki project

New Vercel project → import the repo → **Root Directory** `web/wiki`.
`vercel.json` sets the build; leave the framework preset on "Other".

Settings → Environment Variables:

| Name | Value |
|---|---|
| `WIKI_USERS` | one login per client: `acme:their-password, pixelworks:another-password` |

Deploy. `https://<project>.vercel.app/wiki/` should show the login page.

### 2. Put it on aetherfield.ai/wiki

aetherfield.ai is the Next.js app in `benjaminmales/aetherfield-dynamic-page`.
Its `next.config.js` already forwards `/wiki` and `/wiki/*` to the wiki. In
that project's Vercel settings, add:

| Name | Value |
|---|---|
| `WIKI_ORIGIN` | the wiki project's URL, e.g. `https://aetherfield-wiki.vercel.app` (no trailing slash) |

and redeploy it. Visitors stay on aetherfield.ai the whole time. The login
cookie is set for `aetherfield.ai/wiki` only. Without `WIKI_ORIGIN` the site
simply has no `/wiki` route.

**Trailing slashes:** Next.js strips them before forwarding, so the wiki is
built without them (`trailingSlash: false` in `docusaurus.config.js`, plus
`cleanUrls` in `vercel.json`). Switch either back and pages loop between the
two sites.

### Client logins

`middleware.js` is a Vercel Routing Middleware gate (free on every plan):
branded login page, 30-day cookie, fails closed if nothing is configured.

`WIKI_USERS` holds one login per client, `name:password`, separated by commas
or new lines. Names use letters, digits, `-` and `_`; passwords can be
anything except a comma.

| To | Do |
|---|---|
| Add a client | Add `name:password` to `WIKI_USERS`, then redeploy |
| Remove a client | Delete their entry, redeploy. They're locked out at once; nobody else is affected |
| Change a password | Edit their entry, redeploy. Only that client is signed out |
| See who's been in | Project → Logs, search `wiki login` |
| Sign out | `/wiki/_logout` |

Environment variable changes only apply after a redeploy (Deployments → ⋯ →
Redeploy). It's one login per client company, shared by their people, not
per-person accounts.
