# SignPath Foundation application: draft answers and the owner's checklist

The form itself (<https://signpath.org/apply>) was not read when this was written, so its questions may differ:
these are the facts it is likely to ask for, ready to paste. Nothing here names a person; the maintainer is the
GitHub account **PitsPets**.

## Draft answers

| Question                            | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project name                        | PasaBot                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Repository                          | <https://github.com/PitsPets/pasabot>                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Licence                             | Apache License 2.0 for the whole project ([LICENSE](../LICENSE)); no commercial or dual licence, no proprietary parts. Bundled third-party components keep their own open-source licences (Node.js: MIT; better-sqlite3: MIT, with SQLite in the public domain).                                                                                                                                                                                                                      |
| Description                         | A self-hosted, local-first workspace for a team of AI agents. It runs on the user's own computer; agents use AI "brains" the user already has (Claude Code, Codex, Gemini and others), chat with the user and with each other, and use tools through MCP and skills. No vendor account, no PasaBot relay service, no telemetry.                                                                                                                                                       |
| Download page                       | <https://github.com/PitsPets/pasabot/releases> (the README describes what it does)                                                                                                                                                                                                                                                                                                                                                                                                    |
| Maintenance                         | Actively developed in this repository.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Released already                    | Unsigned Windows previews are built by `.github/workflows/desktop.yml` on every change; the same build, signed, is what this application is for.                                                                                                                                                                                                                                                                                                                                      |
| Build system                        | GitHub Actions on GitHub-hosted runners only (`windows-latest`, `ubuntu-latest`), workflow `.github/workflows/release-windows.yml`, using `signpath/github-action-submit-signing-request` v3.                                                                                                                                                                                                                                                                                         |
| What gets signed                    | PasaBot's own PowerShell scripts (two of the optional tray, and the self-test wrapper), the Inno Setup installer and uninstaller that package them, and the better-sqlite3 database engine compiled in our CI from its pinned source. Third-party prebuilt binaries are never signed. The full list with hashes: [WINDOWS-BINARIES.md](WINDOWS-BINARIES.md). Node.js (already signed by its publisher) and the optional voice engine's upstream libraries are shipped unsigned by us. |
| Artifact configurations             | `.signpath/artifact-configurations/inner.xml` and `installer.xml`                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Product name / version in the files | "PasaBot", version from `apps/server/package.json` (the installer's version info and file name carry it)                                                                                                                                                                                                                                                                                                                                                                              |
| Roles                               | Author / committer, reviewer and approver: PitsPets (<https://github.com/PitsPets>)                                                                                                                                                                                                                                                                                                                                                                                                   |
| Privacy                             | PasaBot sends nothing to other networked systems unless the person using or running it asks for it (details in the README's "Code signing policy" section and docs/SIGNING.md).                                                                                                                                                                                                                                                                                                       |
| System changes                      | Per-user install, no admin rights; nothing outside its own folder, a Start-menu folder, an optional desktop shortcut and an optional Startup entry; a full uninstaller that keeps the user's data unless they choose to delete it.                                                                                                                                                                                                                                                    |

Questions to ask SignPath (or to check in their answer):

1. The database engine is compiled in our CI from a dependency's pinned source (better-sqlite3, MIT). May we sign
   it as ours, or must it stay unsigned inside the signed installer? (On a PC with Smart App Control, an unsigned
   library loaded by the app may be blocked, so this decides whether PasaBot's database opens there.)
2. The PowerShell scripts: is `<powershell-file>` the right element in the artifact configuration?
3. Inno Setup's uninstaller is signed as a separate file (`uninst-*.e32`) before the installer is compiled: is a
   `<pe-file>` with that extension accepted?
4. The exact wording they want under "Code signing policy" (the README uses the usual sentence).

## Owner's checklist (plain words)

1. Turn on two-factor sign-in for your GitHub account (Settings › Password and authentication), if it is not on.
2. Open <https://signpath.org/apply>, fill it in with the answers above, and send it. Wait for their reply.
3. When approved, create your SignPath account with the invitation they send, and turn on two-factor sign-in there.
4. In SignPath, follow their setup for this project: connect the GitHub repository, add the two artifact
   configurations (paste the files from `.signpath/artifact-configurations/`), and make a signing policy where
   every request needs your approval. In that policy, limit the allowed source to this repository's `v*` tags (and
   `main`, only if you want trial runs), so SignPath itself refuses a request built from any other branch.
5. In SignPath, create an API token for a user with the "submitter" role.
6. On GitHub, open the repository › Settings › Environments › **New environment** `release-signing`:
   - **Required reviewers**: you. Every signing run then waits for your click on GitHub too.
   - **Deployment branches and tags**: "Selected branches and tags", add the tag rule `v*` (and the branch `main`,
     only if you want trial runs). A run from any other branch cannot use the environment.
   - **Environment secret** `SIGNPATH_API_TOKEN`: the token from step 5. Put it only here, not as a repository
     secret, so only this environment's approved runs can read it.
7. Still in Settings › Secrets and variables › Actions › Variables, add the repository **variables**
   `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_POLICY_SLUG`, `SIGNPATH_INNER_CONFIG_SLUG`,
   `SIGNPATH_INSTALLER_CONFIG_SLUG` (the names SignPath shows for each).
8. Make a release: push a tag such as `v0.1.0` (or run the "release-windows" workflow by hand on `main` to try it
   first; any other branch is refused).
9. GitHub asks you to approve the run (the environment), then SignPath asks you to approve each signing request
   (two per release: the inner files, then the installer). Approve only requests that come from your own workflow
   run of a `v*` tag (or `main`).
10. When the run is green, open the draft release on GitHub, read it, and publish it. The workflow only ever adds
    files to a draft; it never changes a release that is already published.
