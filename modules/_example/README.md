# `_example` — the reference module

W0a's proof that the Module SDK works. It fills every server and web slot once, so a new workstream can copy
the shape of each:

| Slot                                   | Here                                                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `http` (one route per auth kind)       | `GET /api/m/_example/whoami/{session,automation,run}`, `GET/POST /api/m/_example/notes`                                      |
| `publicHttp` (rate limit + body limit) | `POST /hooks/_example/ping`                                                                                                  |
| `sitesOrigin`                          | `hello.html` on the separate sites origin                                                                                    |
| table (migration, prefixed)            | `_example_note`                                                                                                              |
| tool                                   | `example_echo`                                                                                                               |
| event (EventMap augmentation)          | `example.pinged` on `module:_example`                                                                                        |
| block kind                             | `_example.note` (server schema + web renderer)                                                                               |
| web                                    | page `/example`, nav item, settings section, composer action, header widget, run-event renderer, dock panel, onboarding step |
| locale                                 | `locales/en.json`, `locales/fil.json` (namespace `_example`)                                                                 |

Proof: `pnpm test:sdk`.
