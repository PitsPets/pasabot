# @pasabot/mod-voice (W17)

Push-to-talk speech-to-text and spoken replies, run locally by [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)
in its own child process. Nothing leaves the server by default.

- **Talk** (composer action): hold the mic button (or hold Space/Enter on it). The browser records raw PCM, sends
  a 16 kHz WAV to `POST /api/m/voice/stt`, and the transcript opens in a sheet to fix and send.
- **Listen** (message footer under agent replies): `POST /api/m/voice/tts` returns a WAV, played with Web Audio
  (the app CSP allows no `blob:` media). Spoken audio is cached by voice + text in
  `$PASABOT_HOME/modules/voice/tts-cache/` (least recently used files deleted past 50 MB; not the BlobStore).
  "Read new replies aloud" is a per-device switch.
- **Settings → Voice**: engine state, catalogue models (Whisper tiny for input, Piper Amy for replies), owner-only
  Download / Remove, per-device switches.
- **Fallbacks**: no server voice → the browser's local `speechSynthesis` reads replies. No server STT model → the
  browser's `SpeechRecognition` only when the person switches it on (some browsers send audio to their maker).

## Process model

`src/engine.ts` forks `worker/voice-worker.mjs` (IPC, `serialization: 'advanced'`) with no inherited environment
(only `PATH` and a library path, never the vault passphrase or password-manager sessions). Calls run one at a time,
at most 4 waiting or running (`503 voice_busy` beyond that), each with a 60 s limit counted from the request (queue
time included); a crash, kill or time-out rejects the calls in flight (`503 voice_worker_crashed`,
`504 voice_timeout`) and the next call starts a fresh process. The process stops after 2 minutes idle and when the
server exits. `/stt` and `/tts` allow 30 calls a minute per person each (`429 voice_rate_limited`); a recording's
length (≤ 120 s) and rate (≥ 8 kHz) are read from its WAV header before anything is decoded.

## Models

Downloaded only when the owner asks (`POST /api/m/voice/models/:id/install`, through safe-net), size-capped,
sha256-checked against the entry's pin (a mismatch is refused and leaves nothing; there is no way to install an
unpinned entry, not even in dev: an entry whose real checksum could not be pinned ships `disabled`, is shown to the
owner with a note and answers 409 to install), unpacked with the system `tar` (minimal environment) into a temp folder whose size is watched (tar is
killed past 4 x the download cap or 20 000 entries), cleared of links and special files, then renamed into
`$PASABOT_HOME/modules/voice/models/<id>/`. Piper Amy is pinned to GitHub's published digest; **Whisper tiny ships
disabled** (`disabled: 'unpinned'`: GitHub publishes no digest for that 2024 asset and none could be taken offline);
to turn it on, pin `sha256` from a reviewed download and drop `disabled`. `sherpa-onnx-node` is an optional
dependency: without it the engine reports not ready and the browser fallback applies.

## Tests

- `pnpm vitest run modules/voice` — fixture WAV → transcript, TTS WAV + capped disk cache, crash and time-out,
  owner-only install, checksum (a tampered archive against a real pin) / unpinned / disabled (409) / bz2 bomb /
  bad archive / symlink cleaning, no secret in the speech
  process's environment, header-first length check, busy queue and rate limit, sherpa-without-models → 503. The `fake` driver
  stands in for sherpa in the same worker process.
- Live engine (opt-in): `PASABOT_VOICE_MODELS=<dir with sherpa-onnx-whisper-tiny/ [and vits-piper-en_US-amy-low/]>
  pnpm vitest run modules/voice`.
- Browser: build the web app (`pnpm --filter @pasabot/web exec vite build`), then `pnpm --filter @pasabot/mod-voice
  test:e2e` (1440 and 390 px; Chrome's fake microphone; `PASABOT_VOICE_ENGINE=fake`).
