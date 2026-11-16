# Contributing to PasaBot

Thanks for helping. PasaBot is an independent, Apache-2.0 project: a self-hosted workspace for a team of AI agents.
This page covers setup, the checks every change must pass, how changes flow into `main`, and the two kinds of
data-only contributions that need no code (a language, a country store pack).

## Ground rules

- **Clean room.** Everything you contribute must be your own work. Do not copy code, prompts, text, UI copy,
  names, icons, images, sounds or other assets from any other product, even one PasaBot is compared with in
  `docs/FEATURES.md`. Matching a behaviour is fine; copying how someone else wrote it is not. Third-party
  libraries come in only as declared dependencies under a licence compatible with Apache-2.0.
- **No secrets.** Never commit tokens, keys, passwords, personal email addresses or real phone numbers. Tests use
  fakes and fixtures and need no network and no real accounts.
- **Be kind.** See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Security problems go through
  [SECURITY.md](SECURITY.md), never a public issue.

## Setup

You need Node.js 22 or newer and pnpm 12.18.0 (the version is pinned in `package.json`).

```sh
corepack enable                 # or run every command as: npx pnpm@12.18.0 <cmd>
pnpm install
pnpm dev                        # web app + server for local work
```

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first, then the workstream you are touching in
[docs/ROADMAP.md](docs/ROADMAP.md). Each workstream lists the paths it owns; stay inside them, or say in your pull
request why you could not.

## Checks to run

Run these before you open a pull request. CI runs the same ones.

```sh
pnpm check       # typecheck, lint (biome + dependency-cruiser), unit tests, build
pnpm test:e2e    # Playwright, desktop (1440 px) and phone (390 px)
pnpm test:e2e:all  # the web app's e2e plus every module, plugin and provider e2e suite, one after another
```

`test:e2e` covers only the web app's own specs. A change that touches a module, plugin or provider (or the shell
they plug into, such as onboarding) must also pass `test:e2e:all`. New e2e suites are picked up automatically if
their package has a `test:e2e` script.

Useful while you work: `pnpm format` (biome fixes), `pnpm test -- <path>` for one file, and the named suites in
`package.json` (`test:migrations`, `test:ssrf`, `test:sandbox`, ...).

What a change must keep true:

- Every user-facing string goes through i18n with an entry in every shipped language; the parity test and
  `pnpm i18n:check` fail otherwise (see "Adding a language" below).
- Shared UI comes from `packages/ui`. No text under 12 px, tap targets of at least 44 px on a phone, no sideways
  scroll at 390 px.
- Tests bind servers to `127.0.0.1` on port 0 and stop every child process they start.
- Core ports take an actor; outbound HTTP goes through `packages/safe-net`; secrets live only in the vault and are
  redacted from events and logs; agent-made HTML is served only from the sandboxed origin; trust never goes up
  along a chain of created objects.

## Branches and pull requests

1. Fork the repository and create a branch from `main` named after the change, for example `fix/sign-in-focus`
   or `w24/locale-es`.
2. Keep commits small and focused. Message style: `type(scope): what changed`, for example
   `fix(web): keep focus on the password field`. Types we use: `feat`, `fix`, `docs`, `test`, `chore`, `refactor`.
   Add the workstream when there is one, for example `(W24)`.
3. Sign off every commit (see below).
4. Open a pull request against `main` and fill in the template. Say what you ran and paste the end of its output.
5. A maintainer reviews it. Changes that touch auth, the vault, approvals, the runner sandbox or `safe-net` get a
   second, security-focused review. Pull requests are merged once CI is green and the review is resolved.

### Developer Certificate of Origin

Every commit must carry a sign-off line that certifies the
[Developer Certificate of Origin 1.1](https://developercertificate.org/): you wrote the change, or otherwise have
the right to submit it under the project's licence. Add it with `git commit -s`:

```text
Signed-off-by: Your Name <you@example.com>
```

The name and address are the ones in your own git configuration; a GitHub `noreply` address is fine.

## Adding a language

Strings live in `locales/<code>.json` files next to the code that uses them: core strings in
`packages/i18n/locales/`, the web app in `apps/web/locales/`, and each module or plugin in its own `locales/`
folder. English (`en`) is the source; every other language mirrors its keys. The tagline
"Sabihin mo lang. Ako na bahala." stays as it is in every language; a language other than Filipino puts its own
translation in `app.taglineTranslation`.

A new language is **files only, no code change**: add `<code>.json` (a BCP 47 code such as `it`, `pt-BR` or
`zh-Hant`) beside every `en.json`. Every app loads whatever files exist, and the language picker (onboarding,
Settings, the top bar) lists it. The core file `packages/i18n/locales/<code>.json` also describes the language:

```json
{ "meta": { "name": "Italiano", "dir": "ltr", "status": "unreviewed" } }
```

`name` is the language's name in that language, `dir` is `rtl` for a right-to-left script, and `status` stays
`unreviewed` (the picker then shows an "unreviewed translation" marker with a link back to this section) until a
fluent speaker has read the whole language and a pull request sets it to `reviewed`. Add the code to
`SUPPORTED_LOCALES` in `packages/i18n/src/index.ts` so `i18n:check` and the tests require it everywhere.

`pnpm i18n:check` (part of `pnpm check`) fails on a missing key, an extra key, a placeholder that differs from
`en`, and a value left identical to English. Plural keys (`x_one`, `x_other`) follow each language's own plural
forms, for example only `x_other` in Japanese and six forms in Arabic. A value that is correctly the same as English
(a product name, a key name, a loanword the language really uses) goes on the allow-list in
`packages/i18n/i18n-allow.json`, under `*` or the language code.

- Translate meaning, not word for word, and keep placeholders such as `{{name}}` unchanged.
- Leave product names, commands and code in backticks untranslated.
- Say in the pull request whether a fluent speaker has reviewed the text. Twelve languages (es, pt-BR, fr, de, id,
  vi, hi, ja, ko, zh-Hans, zh-Hant, ar) were machine-written and wait for that review; corrections are very welcome.

## Adding a country store pack

> **Not built yet.** Shopping cards are planned as workstream W30 (`modules/shopping/**`, see the roadmap). This
> section describes the intended contribution so the format is settled before the code lands.

A store pack is one data file per country that lists the online stores people there use most. PasaBot picks the
pack from the owner's locale and region, and the owner can change it, add stores or remove stores in Settings.
Countries without a pack fall back to a generic web search.

When W30 is built, a pack will be a single file under `modules/shopping/` named by the country's ISO 3166-1
alpha-2 code (for example `PH`), listing each store's display name and web address. To propose one:

- Base the list on public popularity data and link your source in the pull request.
- List stores only; no logos, scraped data, affiliate links or tracking parameters.
- One country per pull request.

## Questions

Open a discussion or an issue. For anything security related, use [SECURITY.md](SECURITY.md) instead.
