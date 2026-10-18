# Contributing to pim-agents

Thanks for helping. This file covers what is specific to this repository. Issue
routing, issue templates and the evidence each kind of issue needs are shared
across every `miguelarios` repository and live in the
[account-wide guide](https://github.com/miguelarios/.github/blob/main/CONTRIBUTING.md).
Read its routing table before filing anything.

## Before you start

- **Questions and ideas** go in a comment on the related issue or pull request,
  not a new issue.
- **Bugs** need the evidence the account-wide routing table lists (expected vs
  actual, reproduction steps, logs or output, version, OS and runtime, impact).
  `gh issue create -T Bug` fills in the template.
- **Security problems** are reported as the
  [security policy](https://github.com/miguelarios/.github/blob/main/SECURITY.md)
  describes, never in a public issue.

For anything larger than a small fix, comment on the issue first so the approach
can be agreed before you write the code.

## Setup

Node.js **22.12.0 or newer**, and npm.

```bash
git clone https://github.com/miguelarios/pim-agents.git
cd pim-agents
npm ci
npm run build
```

It is a Turborepo/npm-workspaces monorepo of four packages: `packages/core`
(`@miguelarios/pim-core`, shared code) and the three MCP servers in
`packages/email-mcp`, `packages/cal-mcp` and `packages/card-mcp`. A change to
`core` is picked up by the servers through the workspace link, so rebuild before
testing a server against it.

## The checks a PR must pass

Run these from the repository root before pushing. CI runs the same four steps
on every Node version in its matrix (`.github/workflows/ci.yml`), plus a
gitleaks secret scan:

```bash
npm run lint       # Biome: formatting and lint rules
npm run typecheck
npm run build
npm test           # Vitest across all four packages
```

`npm run format` applies Biome's formatting and safe fixes. Biome is the
formatting gate: double quotes, 2-space indent, semicolons, 100-column lines, and
sorted imports. CI fails on any difference, so run it rather than formatting by
hand.

### Writing tests

- Write the failing test first, then the fix.
- Tests live next to the code in `src/__tests__/*.test.ts`.
- Mock the network libraries (`tsdav`, `imapflow`, `nodemailer`, `mailparser`).
  Tests never talk to a real server.
- Each server's `roundtrip.test.ts` drives a real MCP client over both protocol
  eras. Add a case there when you change what a tool advertises or returns.
- Tests must not depend on the host. `vitest.setup.ts` deletes your own
  `CALDAV_*`, `CARDDAV_*`, `IMAP_*`, `SMTP_*`, `EMAIL_*` and `PIM_*`
  variables before each test file, so a test that needs one sets it with
  `vi.stubEnv`. The host `TZ` is not cleared: pin `PIM_TIMEZONE` in a block
  that asserts on wall-clock times, and undo it in that block's `afterEach`.
  Don't call `vi.unstubAllEnvs()` to "clear" a variable mid-test; it restores
  the original instead.
- Test data uses the reserved synthetic identities, such as `Alice Smith` /
  `alice@example.com` / `+1-555-0100`, and `example.com` hosts. Never commit a
  real name, address, phone number, hostname or credential, including in
  fixtures copied from a real server: scrub them first.

Changes that touch real server behaviour (recurrence, time zones, IMAP flags and
body structure, vCard escaping) should also go through the manual matrix in
[`docs/testing/live-smoke.md`](docs/testing/live-smoke.md) when you have an
account to run it against. Say in the PR whether you did.

## Commits and pull requests

PRs are **squash-merged**. The PR title becomes the commit subject on `main`,
and the commit body is built from your branch's commit messages, so both are
permanent:

- Title the PR in Conventional Commit form, scoped to the package:
  `fix(cal-mcp): …`, `feat(email-mcp): …`, `refactor(core): …`, `docs: …`,
  `chore: …`. Describe the effect a user sees, not the code you touched.
- Write commit messages that explain why, since they end up in the history.
- One PR, one concern. A repo-wide convention change does not ride along with a
  feature.
- Fill in [`.github/pull_request_template.md`](.github/pull_request_template.md).
  Put a `Closes #N` line in its Related section for each issue the PR finishes,
  and paste the output of the checks above.

Design notes that explain decisions and rejected alternatives can go in
`docs/superpowers/specs/`, committed in the same PR as the implementation.
Step-by-step plans and scratch notes stay out of the repository.

### Contributing from a fork

Keep "Allow edits by maintainers" enabled on your PR. GitHub does not offer that
option for a fork owned by an **organization**, so a maintainer cannot rebase or
fix up such a branch. If your fork belongs to an organization, you will need to
rebase it onto `main` yourself when it falls behind or conflicts, and push any
requested changes yourself, or the PR will stall. A fork under your personal
account avoids this.

## Releases

Maintainers handle releases. Do not bump a `version` or add a `CHANGELOG.md`
section in a feature or fix PR: merging a version bump to `main` publishes that
package to npm. The process is described under "Publishing" in
[`CLAUDE.md`](CLAUDE.md).
