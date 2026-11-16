# Brand marks

PasaBot shows the logo of a service next to its name so people recognise it at a glance: the brains (Claude,
Gemini, OpenCode...), connectors (GitHub, Google Calendar...) and shopping stores. One component draws all of them:
`BrandTile` in `packages/ui`. The chat apps (Telegram, WhatsApp, Discord...) have their marks ready but no screen
draws them yet (see "Where marks show").

## The rules

- **The marks belong to their owners.** PasaBot is not affiliated with or endorsed by any of them. A mark is used
  only to identify the service it names, always next to that service's name, never as PasaBot's own branding.
- **Real marks only, never an imitation.** Brand marks come from [Simple Icons](https://simpleicons.org)
  (CC0-1.0; the Git logo is CC BY 3.0, "Git Logo by Jason Long"). When Simple Icons does not ship a brand (or no
  longer does), the tile shows a plain **lettermark** (the first letter of the name on a neutral tile) instead of a
  drawing that looks like the logo. Those are listed below so the owner can decide later.
- **The brand's own colour, when it is readable.** A mark is drawn in its official colour on the neutral tile. If
  that colour stays under 3:1 contrast on the tile in a theme (light tile `#ffffff`, dark tile `#15211b`), the mark is
  drawn in ink (near black or near white) in that theme instead. This is worked out per brand when the data is
  generated; the table says which.
- **Only what is used ships.** `simple-icons` is a dev dependency. A script copies the path data of the listed
  brands into `packages/ui/src/icons/brand-data.gen.ts`; nothing else of the icon set reaches the app.
- Things that are not a brand (a folder, a clock, your own tool server, a custom store) keep PasaBot's own line
  glyphs (`packages/ui/src/icons/brands.tsx`, Apache-2.0).

## How to add a brand

1. Find its slug on [simpleicons.org](https://simpleicons.org). Check its brand guidelines link there.
2. Add a line to `BRANDS` in `packages/ui/scripts/gen-brands.ts` (`[id, slug, label, group]`). If Simple Icons does
   not have it, add it to `LETTERS` instead (`[id, letter, label, group]`); never draw the logo yourself.
3. Run `npx tsx packages/ui/scripts/gen-brands.ts && npx biome format --write packages/ui`. It refreshes
   `brand-data.gen.ts`, the SVGs and `manifest.json` in `packages/ui/assets/icons/`, and prints each colour's
   contrast.
4. If the id a screen passes differs from yours (`tiktok-shop`, `local:ollama`), add it to `ALIASES` in
   `packages/ui/src/brand-tile.tsx`.
5. Add the brand to the lists below. `packages/ui/src/brand-tile.test.tsx` fails until it is listed here, and when
   the path or colour stops matching the installed Simple Icons.

To update Simple Icons: bump the exact version of `simple-icons` in `packages/ui/package.json`, run step 3, and
move any brand it dropped to `LETTERS` (the script stops and names it).

## Where marks show

Every screen below draws a `BrandTile` today (checked by reading the source in `apps/web/e2e/brand-logos.spec.ts`,
which also checks that every id these screens pass resolves to a mark).

| Place                                                     | Where in the code                                                                    | What it shows                                                                                                                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat header's "Thinks with" picker                        | `apps/web/src/chat/ModelPicker.tsx`                                                  | the agent's brain and every ready brain                                                                                                                                               |
| Chat details                                              | `apps/web/src/chat/Details.tsx`                                                      | the agent's main brain and its backups                                                                                                                                                |
| Agent form and onboarding brain step                      | `apps/web/src/agents/BrainPicker.tsx` (`BrainTile`), `apps/web/src/chat/Welcome.tsx` | each brain to pick                                                                                                                                                                    |
| Brains page                                               | `modules/provider-ops/web/brains.tsx`                                                | each brain of the catalogue (`local` and `acp` groups: the own glyph)                                                                                                                 |
| Connectors (catalogue, installed, found on this computer) | `modules/connectors/web/index.tsx`                                                   | every catalogue app (GitHub, Notion, Jira and Confluence, Trello, ClickUp, Intercom, Stripe...), the "is connected" chat card, and any known brand a found tool server is named after |
| Tool servers (MCP)                                        | `modules/mcp/web/index.tsx`                                                          | a connector's mark, or the own server glyph                                                                                                                                           |
| Shop settings                                             | `modules/shop/web/index.tsx`                                                         | each store of the country pack                                                                                                                                                        |
| Email inbox                                               | `modules/inbox/web/index.tsx`                                                        | the own inbox and bridge glyphs                                                                                                                                                       |

### Not wired yet

| Place                                       | Today                                                         | Marks ready                                                   |
| ------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| Chat apps (chat header, chat apps settings) | the generic channels glyph (`apps/web/src/chat/ChatView.tsx`) | Telegram, WhatsApp, Discord, Messenger; Slack is a lettermark |

## Open for the owner

- **Codex (OpenAI) and Grok (xAI) are brains people pick every day, and they show a plain letter ("C", "G"), not their
  logo.** Simple Icons does not ship either mark, and PasaBot never draws an imitation. Two choices: (a) use the
  official mark from the OpenAI and xAI brand pages, if their terms allow it to identify the service, and record the
  source and terms here; or (b) keep the lettermark. Until the owner chooses, the logo complaint is not fully fixed
  for these two.

## Real marks (Simple Icons 16.36.0)

Colour columns: "brand" = drawn in the brand colour on that theme's tile, "ink" = its colour is under 3:1 there.

| Id                | Service                  | Source                        | Colour  | Light | Dark  | Licence                            |
| ----------------- | ------------------------ | ----------------------------- | ------- | ----- | ----- | ---------------------------------- |
| `claude`          | Claude                   | Simple Icons `claude`         | #D97757 | brand | brand | CC0-1.0                            |
| `gemini`          | Gemini                   | Simple Icons `googlegemini`   | #8E75B2 | brand | brand | CC0-1.0                            |
| `opencode`        | OpenCode                 | Simple Icons `opencode`       | #000000 | brand | ink   | CC0-1.0                            |
| `ollama`          | Ollama (local model)     | Simple Icons `ollama`         | #000000 | brand | ink   | CC0-1.0                            |
| `lmstudio`        | LM Studio (local model)  | Simple Icons `lmstudio`       | #000000 | brand | ink   | CC0-1.0                            |
| `github`          | GitHub / GitHub (hosted) | Simple Icons `github`         | #181717 | brand | ink   | CC0-1.0                            |
| `git`             | Git repository           | Simple Icons `git`            | #F03C2E | brand | brand | CC BY 3.0 (Git Logo by Jason Long) |
| `google`          | Google                   | Simple Icons `google`         | #4285F4 | brand | brand | CC0-1.0                            |
| `google-calendar` | Google Calendar          | Simple Icons `googlecalendar` | #4285F4 | brand | brand | CC0-1.0                            |
| `gmail`           | Gmail                    | Simple Icons `gmail`          | #EA4335 | brand | brand | CC0-1.0                            |
| `icloud`          | iCloud Mail              | Simple Icons `icloud`         | #3693F3 | brand | brand | CC0-1.0                            |
| `notion`          | Notion                   | Simple Icons `notion`         | #000000 | brand | ink   | CC0-1.0                            |
| `atlassian`       | Jira and Confluence      | Simple Icons `atlassian`      | #0052CC | brand | ink   | CC0-1.0                            |
| `trello`          | Trello                   | Simple Icons `trello`         | #0052CC | brand | ink   | CC0-1.0                            |
| `clickup`         | ClickUp                  | Simple Icons `clickup`        | #7B68EE | brand | brand | CC0-1.0                            |
| `intercom`        | Intercom                 | Simple Icons `intercom`       | #6AFDEF | ink   | brand | CC0-1.0                            |
| `stripe`          | Stripe                   | Simple Icons `stripe`         | #635BFF | brand | brand | CC0-1.0                            |
| `telegram`        | Telegram                 | Simple Icons `telegram`       | #26A5E4 | ink   | brand | CC0-1.0                            |
| `whatsapp`        | WhatsApp                 | Simple Icons `whatsapp`       | #25D366 | ink   | brand | CC0-1.0                            |
| `discord`         | Discord                  | Simple Icons `discord`        | #5865F2 | brand | brand | CC0-1.0                            |
| `messenger`       | Messenger                | Simple Icons `messenger`      | #0866FF | brand | brand | CC0-1.0                            |
| `shopee`          | Shopee                   | Simple Icons `shopee`         | #EE4D2D | brand | brand | CC0-1.0                            |
| `tiktok`          | TikTok Shop              | Simple Icons `tiktok`         | #000000 | brand | ink   | CC0-1.0                            |
| `ebay`            | eBay                     | Simple Icons `ebay`           | #E53238 | brand | brand | CC0-1.0                            |
| `rakuten`         | Rakuten                  | Simple Icons `rakuten`        | #BF0000 | brand | ink   | CC0-1.0                            |
| `target`          | Target                   | Simple Icons `target`         | #CC0000 | brand | ink   | CC0-1.0                            |
| `argos`           | Argos                    | Simple Icons `argos`          | #DA291C | brand | brand | CC0-1.0                            |
| `fnac`            | Fnac                     | Simple Icons `fnac`           | #E1A925 | ink   | brand | CC0-1.0                            |
| `naver`           | Naver Shopping           | Simple Icons `naver`          | #03C75A | ink   | brand | CC0-1.0                            |
| `otto`            | Otto                     | Simple Icons `otto`           | #D4021D | brand | brand | CC0-1.0                            |

## Lettermarks (Simple Icons does not ship these)

Checked against Simple Icons 16.36.0. Each shows the letter on a neutral tile, in ink (brains in their PasaBot
tone). Adding a real mark for any of them is the owner's decision.

| Id                | Service                       | Letter |
| ----------------- | ----------------------------- | ------ |
| `codex`           | Codex (OpenAI)                | C      |
| `openai`          | OpenAI                        | O      |
| `grok`            | Grok (xAI)                    | G      |
| `slack`           | Slack                         | S      |
| `outlook`         | Outlook (Microsoft)           | O      |
| `amazon`          | Amazon                        | A      |
| `walmart`         | Walmart                       | W      |
| `lazada`          | Lazada                        | L      |
| `flipkart`        | Flipkart                      | F      |
| `coupang`         | Coupang                       | C      |
| `mercado`         | Mercado Libre / Mercado Livre | M      |
| `tokopedia`       | Tokopedia                     | T      |
| `meesho`          | Meesho                        | M      |
| `kmart`           | Kmart                         | K      |
| `noon`            | noon                          | N      |
| `gmarket`         | Gmarket                       | G      |
| `yahoo`           | Yahoo! Shopping               | Y      |
| `magalu`          | Magalu                        | M      |
| `tiki`            | Tiki                          | T      |
| `momo`            | momo                          | M      |
| `pchome`          | PChome                        | P      |
| `cdiscount`       | Cdiscount                     | C      |
| `el-corte-ingles` | El Corte Inglés               | E      |
