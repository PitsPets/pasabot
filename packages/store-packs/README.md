# @pasabot/store-packs (W30)

Store packs for the shop module: **data only**. One JSON file per country in `packs/<CC>.json` (ISO 3166-1
alpha-2; the United Kingdom is `GB`), validated by `packSchema` and found by discovery (`loadPacks(dirs)` reads
every `*.json`), so a new country is a new file and no code change. A file that does not validate is skipped and
reported, never half-loaded.

Per store: `id` (stable, lowercase), `name` (plain text), `homeUrl`, `searchUrl` with exactly one `{query}`
(filled URL-encoded by `fillSearch`, which refuses any result whose parameters or host differ from the template),
`allowedHosts` (exact hosts or `*.suffix`; links, images and navigation outside them are refused by the shop
module), `currency` (ISO 4217) and `parsingHints` (`prefer`: `json-ld` / `opengraph` / `microdata`, optional
plain CSS `selectors` and optional `cart` steps). The schema is strict: no logo or image field, no regex or code,
and no affiliate or tracking parameter (`TRACKING_PARAMS`) in any URL field.

`regionFor({ region, locale })` / `packFor(packs, …)` pick the owner's country from the region setting, then the
locale's region subtag (`fil-PH` → PH), then the language's main market; never an IP lookup or a network call.
A country without a pack falls back to generic web search.

The shipped selectors are deliberately empty: the shop module reads structured data first (JSON-LD `Product` /
`Offer`, OpenGraph product tags, microdata). Store hosts and search templates were written from public store
addresses and have not been checked against each live store.

Tests: `vitest run packages/store-packs`.
