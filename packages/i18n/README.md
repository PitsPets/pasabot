# @pasabot/i18n

i18next setup (`createI18n`; every language falls back to `en` per key), core strings in `locales/`, and the
locale merger (`mergeLocaleFiles` for globbed files; `@pasabot/i18n/node` `loadLocaleDir` for the server).
Every package's `locales/<code>.json` is merged under its folder name as namespace; core strings under `core`.

Languages (W24): `SUPPORTED_LOCALES` lists the 14 shipped ones (en, fil, es, pt-BR, fr, de, id, vi, hi, ja, ko,
zh-Hans, zh-Hant, ar). Nothing at runtime depends on that list: a language is whatever files exist, and its core file
carries `meta` (own name, `dir`, `status: reviewed | unreviewed`).

- Modules load their own files with `localeResources('<id>', import.meta.glob('../locales/*.json', { eager: true,
  import: 'default' }))` and follow the shell's `<html lang>` with `documentLocale()`.
- `resolveLocale(navigator.languages)` picks the best shipped language (`zh-TW` -> `zh-Hant`, `pt` -> `pt-BR`,
  `tl` -> `fil`); `dirOf`, `localeMeta`, `availableLocales`.
- Dates and numbers: `intlLocale(lng)` (`fil` -> `fil-PH`) and `displayLocale()`: always the app language (for
  `en`, the device's English region such as en-PH when the device is in English, plain `en` otherwise). Never pass
  `undefined` or a hard-coded locale to `toLocale*` / `Intl` for text the owner reads.
- `pnpm i18n:check` (`src/check.ts`): missing / extra keys (plural forms per language), placeholder mismatches and
  values left identical to English (allow-list: `i18n-allow.json`). Prints the coverage of each language.
