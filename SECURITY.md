# Security policy

PasaBot runs agents that can use tools on your own machine, so we take security reports seriously.

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request for a security problem.**

Report it privately through GitHub: open the repository's **Security** tab, choose **Report a vulnerability**,
and fill in the private advisory form. Only the maintainer can see it. This is the only reporting channel; there
is no security email address.

Please include:

- what is affected (component, version or commit) and how it is set up;
- the steps to reproduce, or a proof of concept;
- what an attacker gains (for example: an agent escaping its trust level, a secret leaking into logs or events,
  outbound traffic that bypasses `safe-net`, agent-made HTML running outside the sandboxed origin, or a way to act
  as the owner);
- whether the issue is already public anywhere.

## What happens next

The maintainer acknowledges the report, works with you on a fix in the private advisory, and publishes the
advisory with credit to you (unless you prefer not to be named) once a fixed version is available. Please give us
reasonable time to fix the issue before you disclose it.

## Supported versions

PasaBot is pre-alpha. Only the latest commit on `main` receives security fixes.

## Out of scope

- Problems that need an attacker to already control the owner's account or the host machine.
- Reports from automated scanners without a demonstrated impact.
- Issues in third-party agent CLIs or services; report those to their own maintainers.
