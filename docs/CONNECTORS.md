# Connectors: the catalogue and where each entry comes from

PasaBot's Connectors page (`/connectors`) lists apps a helper can use. Each entry is a manifest in
`catalog/connectors/<slug>/<version>.json`, validated by `modules/connectors/src/manifest.ts` and by
`modules/connectors/src/w36.test.ts`: every shipped entry names the official page it was checked against
(`source`), runs a pinned release or the vendor's own `https` endpoint, sits in one section, has a plain line in
English and Filipino, and declares the classes of the tools it knows (anything that sends, posts, pays or deletes
always asks; tools a manifest does not name are classed by the conservative default classifier when the server
lists them).

How a person adds one: **Add** (nothing to type), **Sign in** (the app's own page opens in the browser after one
card says what the helper will be able to do), **Needs a code** (a button opens the app's own page for the code; a
hosted app is tested before it counts as added, with a plain reason when it fails). Added apps show under
**Connected**, with **Who can use it** (the main helper only, at first) and a card in the main helper's chat:
"<App> is connected", with two things to tap and ask.

## In the catalogue

Checked on 2026-11-15. "Own sign-in" = the MCP server publishes RFC 9728 / RFC 8414 metadata with a dynamic client
registration endpoint and PKCE S256, read live from the endpoint (a read-only GET of public metadata; no account
was used and no client was registered while checking).

| App                 | Section            | How                                        | Endpoint / package                                  | Source (official)                                                                          | Checked how                                                                                  |
| ------------------- | ------------------ | ------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Notion              | Files and notes    | Hosted, own sign-in                        | `https://mcp.notion.com/mcp`                        | https://developers.notion.com/guides/mcp/get-started-with-mcp                              | Doc page names the URL and browser sign-in; live metadata: registration + S256               |
| Jira and Confluence | Work and tasks     | Hosted, own sign-in                        | `https://mcp.atlassian.com/v2/mcp`                  | https://github.com/atlassian/atlassian-mcp-server (Apache-2.0)                             | README names v2 `/mcp` as recommended; live metadata: auth.atlassian.com registration + S256 |
| Trello              | Work and tasks     | Hosted, own sign-in                        | `https://mcp.trello.com/v1`                         | https://support.atlassian.com/trello/docs/connect-trello-to-ai-assistants-with-trello-mcp/ | Atlassian support page names the URL; live metadata: registration + S256                     |
| ClickUp             | Work and tasks     | Hosted, own sign-in (public beta)          | `https://mcp.clickup.com/mcp`                       | https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server          | ClickUp developer docs name the URL; live metadata: registration + S256                      |
| Intercom            | Social and chat    | Hosted, own sign-in (US-hosted workspaces) | `https://mcp.intercom.com/mcp`                      | https://developers.intercom.com/docs/guides/mcp                                            | Intercom developer docs name the URL (EU: `mcp.eu.intercom.com`, not added); live metadata   |
| Stripe              | Shop and money     | Hosted, own sign-in                        | `https://mcp.stripe.com`                            | https://docs.stripe.com/mcp                                                                | Doc page names the URL, OAuth and the tool list; money tools classed `money`; live metadata  |
| Google Calendar     | Calendar and email | Owner's own Google OAuth client (W13)      | Google OAuth (read-only scope)                      | https://developers.google.com/calendar/api/guides/auth                                     | W13 entry; a token is stored, no agent tool uses it yet                                      |
| GitHub              | Other              | Runs locally (Docker), needs a code        | `ghcr.io/github/github-mcp-server@sha256:250bc6ce…` | https://github.com/github/github-mcp-server (MIT)                                          | W13 entry (pinned digest)                                                                    |
| GitHub (hosted)     | Other              | Hosted, needs a code                       | `https://api.githubcopilot.com/mcp/`                | https://github.com/github/github-mcp-server                                                | W13 entry; code page `github.com/settings/personal-access-tokens/new`                        |
| Files in a folder   | Files and notes    | Runs locally (Node.js)                     | `@modelcontextprotocol/server-filesystem@2.1.0`     | https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem                   | W13 entry (pinned)                                                                           |
| Git repository      | Other              | Runs locally (uv)                          | `mcp-server-git==2026.10.28`                        | https://github.com/modelcontextprotocol/servers/tree/main/src/git                          | W13 entry (pinned)                                                                           |
| Time and time zones | Other              | Runs locally (uv)                          | `mcp-server-time==2026.10.28`                       | https://github.com/modelcontextprotocol/servers/tree/main/src/time                         | W13 entry (pinned)                                                                           |

Tool classes declared: Stripe `stripe_api_write`, `send_money`, `transfer_money`, `convert_currency`,
`setup_recipient` = money and `send_stripe_feedback` = outbound message (from Stripe's tool table); Notion
`notion-create-comment` = outbound message (named on Notion's page); Jira and Confluence: comment and new-issue
tools = outbound message, `createConfluencePage` = publish (Atlassian's v1 tool names; any v2 name not listed is
classed by the default classifier). Trello, ClickUp and Intercom publish no tool list on the pages read: their
tools are classed by the default classifier on first listing, and the owner can correct each on the MCP page.

**Not verified with a real account:** none of the six new apps has been signed in to for real (that needs the
owner's own Notion, Atlassian, Trello, ClickUp, Intercom and Stripe accounts). The whole sign-in path (discovery,
registration, PKCE, `resource`, token, tool call) is proven against a fake app on 127.0.0.1 in unit and browser
tests.

## Coming soon (not addable yet)

| App                                                                                                                                               | Why it waits                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gmail, Google Drive, Sheets, Docs, Chat, Contacts; Calendar via MCP                                                                               | Official endpoints exist (`*mcp.googleapis.com/mcp/v1`, developers.google.com/workspace/guides/configure-mcp-servers) but they are a Developer Preview that needs membership of Google's Workspace Developer Preview Program plus the owner's own Google Cloud OAuth client: not something most people can do. |
| PayPal                                                                                                                                            | Official remote server (`mcp.paypal.com`, developer.paypal.com/tools/mcp-server/) but the page names no tool list, so its money tools cannot be classed before shipping; research confidence medium.                                                                                                           |
| Slack                                                                                                                                             | Official server (`mcp.slack.com/mcp`) accepts only directory-published or internal Slack apps with admin approval; PasaBot cannot just sign in.                                                                                                                                                                |
| Zoom, HubSpot, Asana                                                                                                                              | Hosted servers answer, but their sign-in servers take no new apps (no registration endpoint), so each owner would have to create a developer app first. Asana research confidence was low.                                                                                                                     |
| Figma                                                                                                                                             | Hosted server with registration, but Figma limits which apps may sign in; not checked without registering a client.                                                                                                                                                                                            |
| Linear, Canva                                                                                                                                     | Their hosted servers publish sign-in metadata with registration (checked live), but the research had low confidence and no vendor doc page was read; add after a doc check.                                                                                                                                    |
| Microsoft 365 (Outlook, OneDrive, Teams)                                                                                                          | Work IQ MCP needs a Microsoft 365 Copilot licence; endpoint not confirmed on a Microsoft page.                                                                                                                                                                                                                 |
| Dropbox, Shopify (stores), QuickBooks, Meta (Facebook, Instagram, WhatsApp), YouTube, Google Maps, Airtable, Vercel, Supabase, Sentry, Cloudflare | No official, everyday endpoint confirmed (Claude-only URLs, developer-docs-only servers, third-party or archived servers, or none found).                                                                                                                                                                      |
