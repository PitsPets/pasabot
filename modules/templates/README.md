# @pasabot/mod-templates (W22)

Agent templates, "make me an agent that…" drafts, template bundles and importers, and the onboarding **free starter**.

## What it does

- **Catalogue** (`GET/POST/DELETE /api/m/templates/catalog`): built-ins from `catalog/templates/<id>/template.json`, a
  template folder on the server (absolute path), a static index (`{ "templates": [...] }` fetched over safe-net), or
  an imported file. Owner only.
- **Drafts** (`POST /draft`): a valid draft from a plain request, built without a model call (closest template by
  tags + the owner's words). The owner reviews it on `#/templates`; the web app then creates the agent through the
  core agents API, at the server's default trust. Nothing is created without that click.
- **Publish = export** (`GET /catalog/:id/export`, `GET /agents/:id/export`): a `.pasabot-template.json` bundle (name,
  description, instructions, brain hint; never secrets, trust or workspace). Import (`POST /import`) round-trips equal.
- **Importers**: our bundle, Markdown agent files with a `name:`/`description:` front matter block (the public
  sub-agent layout several coding CLIs use), and assistant-style JSON (`name`, `instructions`). Imported text is
  only a draft.
- **Onboarding step** (web `onboardingSteps`): free starter, guided setup (provider detection + install hints via
  `/api/v1/providers`), and later the W34 local model.
- **Free starter** (`GET /starter`, `POST /starter/install`, `POST /starter/agents`, page `#/starter`): with the
  owner's consent, installs the OpenCode CLI per user (default `~/.local/bin`, or `$PASABOT_TOOLS_BIN`) from the
  latest GitHub release over safe-net, checking the SHA-256 digest the release publishes before writing anything
  (`src/install/installer.ts`; only from the catalog's `hosts` list, with safe-net's private-address guard on and a
  User-Agent, up to 300 MB); then the web app creates a first agent on a free model from
  `catalog/templates/free-models.json` (data with a `checkedAt` date, never UI copy). A failed install leaves
  nothing behind and the step falls back to guided setup. The W31 global stop refuses a new install (409 `stopped`)
  and aborts one in flight (named in the stop report as `install`); nothing is written after the stop.
- **Free-tier gate** (`src/free-tier.ts`): the module puts a thin wrapper in front of the `opencode` adapter. Turns
  on a free model run one at a time across all agents (one shared quota); a 429/quota error closes the gate until the
  reset with one plain "busy or out of quota, try again at …" message, and while closed a free-model turn ends at
  once without calling the model (so the core's single retry + hold never becomes a retry storm). A queued turn
  leaves at once when cancelled and gives up with the busy message after 10 minutes. Three auth errors or "model not
  found" answers in a row mark the model broken: the owner gets a notification and the "pick another brain" notice.
  The mark clears after a clean turn, a refreshed `free-models.json` (new `checkedAt`) or `POST /starter/recheck`;
  the notice counts only starter agents that still run on that model. Other models pass straight through.

## Tests

- `npx vitest run modules/templates` — catalogue, drafts, bundle round-trip, importers, consent, checksum,
  first answer with no key, 429 handling, one-at-a-time, cancel and wait bound, notice (and how it clears), and
  the release installer through the real SafeNet port against a 127.0.0.1 stub (User-Agent, 11 MB, host list).
- `cd modules/templates && npx playwright test` — onboarding (three options, consent text, free starter answer,
  fallback to guided setup when the stub installer fails) and the templates page, at 1440 and 390. Needs a built
  `apps/web/dist`.
- Live (manual, `PASABOT_LIVE=opencode`): the real install and one real free-model answer — not automated yet.

- **Free-model routines** (wave 5): a queue gate refuses a `routine` item while the gate is closed when the provider
  policy would run it on the free model right now (asked as the orchestrator asks it, from the agent's configured
  brain, never its last run: a fallback chain that still has a usable brain runs the fire there), and a routine item the core held mid-turn with the busy message is released at once and refused
  the same way. The routines module records the fire `skipped` with `rate limited: …` (its Activity says so in
  plain words), one notification per busy window, nothing stacks as pending or held, and the next fire after the
  reset runs as usual.
- **Local model (onboarding option 2)**: the step asks the local models module (`GET /api/m/local/detect`) and shows
  the card only when a loopback endpoint answered; the owner's click adds it through the owner-only
  `POST /api/m/local/endpoints` (agents and tokens are refused; no tool adds an address).
- **`pasabot providers install <id>`** (`apps/cli`): `GET /providers/installable` (what, where, from where, checksum)
  and `POST /providers/:id/install` (`consent: true`), owner only, the same checksum-verified installer.
- **No longer free**: the notice carries the model's name and a `kind` (`not_free`, `needs_key`, `unavailable`)
  the page translates, and the owner is notified once per model and list date.

## Tests (wave 5)

- `npx vitest run modules/templates/src/wave5.test.ts apps/cli` — routine skip and report, notice, providers
  install (owner only, consent, SHA-256 mismatch writes nothing), local option (agent refused), the CLI verb.

## Not done

- Git URL templates and a language step in onboarding (needs the app's language setter exposed to modules).
- Live (`PASABOT_LIVE=opencode`): the real install and a real free-model answer.
