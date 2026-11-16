## What and why

<!-- What does this change do, and why? Link the issue and the workstream (for example W24). -->

## How it was checked

<!-- Paste the end of the output. -->

- [ ] `pnpm check` (typecheck, lint, unit tests, build)
- [ ] `pnpm test:e2e`, if the web app changed

## Checklist

- [ ] Stays inside the paths its workstream owns, or explains why not
- [ ] New UI strings have `en` and `fil` entries; shared UI comes from `packages/ui`
- [ ] No text under 12 px, 44 px tap targets on a phone, no sideways scroll at 390 px
- [ ] Tests need no network or real accounts, bind to `127.0.0.1` port 0 and stop what they start
- [ ] No secrets, personal data or real phone numbers in code, fixtures or logs
- [ ] Security house rules kept (actor on core ports, outbound HTTP through `safe-net`, secrets only in the vault,
      agent HTML only on the sandboxed origin, trust never escalates)
- [ ] Clean room: no code, prompts, text, names or assets copied from another product
- [ ] Every commit is signed off (`git commit -s`, DCO)
