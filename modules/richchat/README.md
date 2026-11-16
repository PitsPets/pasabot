# @pasabot/mod-richchat (W7)

Rich chat output and rich attachments.

- **Ask cards** — tool `richchat_ask` (tier 0): a question with 2–8 tappable answers. The tool posts a
  `richchat.ask` block and waits until the person who started the run, or an owner, answers
  (`POST /api/m/richchat/prompts/:id/answer`; anyone else 403 `not_your_prompt`, guests and observers 403
  `read_only`), the timeout passes (`expired`) or the run is cancelled (`cancelled`); the card updates in place.
  The result names who answered (`by: { id, kind, trust }`).
- **Forms** — tool `richchat_form` (tier 0): schema-driven fields (text, textarea, number, select, checkbox, date),
  validated on the server against the same field spec before the values return to the run, marked `untrusted`
  (typed by a person: data, never instructions) with `by`. Same answer rule as ask cards.
- **HTML** — tool `richchat_html` (tier 1): the page is written to the separate sites origin under an
  unguessable name and shown in `<iframe sandbox="allow-scripts">`; every sites response carries
  `CSP: sandbox allow-scripts` + `nosniff`, and the app refuses that origin (ARCHITECTURE 8, "Exposure").
- **Attachments** — composer action "Attach files": resumable upload (`POST /uploads`, `PUT /uploads/:id` with
  `x-upload-offset`, `GET` to resume, `POST /uploads/:id/complete` into the BlobStore), 100 MB per file and
  250 MB per message (both also enforced by the core); the message carries a `richchat.files` block (the only
  user-authored kind) that shows image thumbnails with a lightbox, audio/video players, SVG as an image, and
  download chips for ZIP and other files. Downloads go through the core `GET /api/v1/blobs/:sha` (membership
  checked, `nosniff`, sandbox CSP, HTML never inline).

Tables: `richchat_prompt`, `richchat_upload`. Prompts still open at boot are closed as `cancelled` (their runs
ended with the old process).

Tests: `pnpm vitest run modules/richchat` (a probe provider calls the tools through `/mcp` with its run bearer).
Browser: build the web app (`apps/web`: `vite build`), then `pnpm --filter @pasabot/mod-richchat test:e2e`
(Playwright, desktop + 390 px; `e2e/server.ts` boots a throwaway server with the probe provider).
