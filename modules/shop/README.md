# @pasabot/mod-shop (W30)

Product cards, compare and a Buy that stops at the cart.

- **Stores.** Country packs come from `@pasabot/store-packs` (data only). The owner's country is the stored pick,
  else the region/locale (`GET /settings?locale=`), never an IP lookup or any network call. The owner's first
  settings load saves that default when it has a pack, so the stores the owner is shown are the ones agents are held
  to; until a country is saved, agents get no store at all (no capture, no search). Settings → Shopping
  (and a country card on the welcome page) switches country, turns stores on/off and adds **custom stores** (same
  fields as a pack entry; their hosts count for that store only). Only an owner session changes these: run,
  automation and member principals get 401/403, and no agent tool edits stores.
- **Captured products.** `shop_capture` reads a product page through the managed browser port
  (`ModuleHost.browser`, set by the browser module) and stores what the page's **structured data** says (JSON-LD
  `Product`/`Offer`, OpenGraph product tags, microdata, then the pack's plain CSS selectors) with its capture time
  (`shop_product`). Names are cleaned plain text; images and links survive only on the store's `allowedHosts`;
  prices are never converted. The agent gets the facts inside a labelled untrusted block and only ever names a
  product id afterwards. A page address off the enabled stores, or a sign-up page, is refused. A country without a
  pack, picked by the owner, falls back to a generic web search and a one-host store per captured page, never on a
  host of a store the owner turned off. `shop_search` and `shop_capture` are tier 2 on a signed-out browser
  profile and tier 3 on one that may hold the owner's sign-ins (as the browser tools); the port re-checks the
  profile when it touches the page, under the same per-profile page lock as the browser tools.
- **Cards.** `shop_show` posts a `shop.product` block, `shop_compare` a `shop.compare` block of 2–4 products (1 or
  5 is refused). The web renders them as text: image via `safeImageSrc` and link via `safeHref`, each only on the
  block's store hosts (else a plain "No picture" and no link); the price in the store's currency formatted for the
  owner's locale; "as seen at <time>" in the owner's time zone.
- **Buy.** `shop_buy` (tier 3, `actionClass: 'money'`, `noAlwaysAllow`) and the card's Buy button
  (`POST /products/:id/buy`, a detached approval with the same `ask` card) raise a money card built from the
  captured product: what (quantity × name, price each, as seen at), store and host, total "as seen, not final",
  and "you pay yourself". Nothing touches the browser before approval. After approval the server, not the agent:
  opens the approved product page on an allowed host, re-reads it (another name, price or currency **stops**),
  fills the approved quantity, clicks add-to-cart, opens the cart/checkout page, then **hands the live view over**
  and posts a plain message in the chat. A captcha or a sign-in wall pauses and hands over; the port refuses card,
  bank, password and one-time-code fields and any pay / place-order control; sign-up pages are never opened. A
  store without `parsingHints.cart` gets the product page opened and handed over. The global stop (W31) ends a Buy
  in progress (`shop-buy` in the stop report).

Owner REST under `/api/m/shop/`: `GET/PUT /settings`, `POST /custom-stores`, `DELETE /custom-stores/:id`,
`GET /products`, `GET /products/:id`, `POST /products/:id/buy`, `GET /orders` (newest 50), `GET /orders/:id`.

Tests: `vitest run modules/shop` (booted server, `/mcp` gateway, a local fixture store on 127.0.0.1 port 0 mapped by
a test pack, the stand-in browser in `src/testing/`; the real port is proven in `modules/browser/src/port.test.ts`)
and `pnpm --filter @pasabot/mod-shop test:e2e` (build the web app first) at 1440 and 390 px, where the shared e2e
server's real browser module captures the fixture pages.
