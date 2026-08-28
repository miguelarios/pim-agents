# CLAUDE.md

## Project Overview

PIM Agents — AI agent tooling for email (IMAP/SMTP), calendar (CalDAV), and contacts (CardDAV).

Monorepo with 4 packages:
- `packages/core` — `@miguelarios/pim-core` — shared config, validation, errors, vCard utilities
- `packages/card-mcp` — `@miguelarios/card-mcp` — CardDAV contacts MCP server (6 tools)
- `packages/email-mcp` — `@miguelarios/email-mcp` — IMAP/SMTP email MCP server (12 tools)
- `packages/cal-mcp` — `@miguelarios/cal-mcp` — CalDAV calendar MCP server (11 tools)

## Development Commands

- `npm run build` — Build all packages via Turborepo
- `npm test` — Run all tests via Vitest
- `npm run lint` — Lint via Biome
- `npm run format` — Auto-format via Biome
- `npm run typecheck` — Type-check all packages

### Package-specific
- `cd packages/core && npx vitest run` — Run core tests
- `cd packages/card-mcp && npx vitest run` — Run card-mcp tests
- `cd packages/email-mcp && npx vitest run` — Run email-mcp tests

## Architecture

- MCP-first: each server uses `@modelcontextprotocol/server` v2 (`McpServer` + `serveStdio`) and speaks protocol revision `2026-07-28`, while still serving 2025-era clients from the same tool definitions
- Tools are declared as `ToolDef[]` arrays and registered via `registerTools` from `@miguelarios/pim-core/mcp` — that subpath is the shared MCP facade (schemas, result helpers, error mapping, confirmation gate)
- Input schemas are hand-written JSON Schema wrapped with `fromJsonSchema`; output schemas are valibot, converted with `@valibot/to-json-schema`
- Irreversible operations gate on `confirmDestructive`, which uses the spec's multi round-trip request pattern (`PIM_MCP_CONFIRM=off` bypasses it)
- CLI access via MCPorter (no separate CLI wrappers needed)
- Per-server credentials via env vars
- Shared core library for config, errors, vCard parsing

## Code Style

- TypeScript strict mode, ES modules
- Double quotes, 2-space indent, semicolons (Biome enforced)
- PascalCase classes, camelCase functions/variables
- Valibot for validation (not Zod)
- Test with Vitest, globals enabled

## Testing

- TDD: write failing test first, then implement
- Unit tests next to source: `src/__tests__/*.test.ts`
- Mock external dependencies (tsdav, imapflow, nodemailer, MCP SDK)
- `vi.mock("tsdav")` for CardDAV tests
- `vi.mock("imapflow")` and `vi.mock("mailparser")` for email IMAP tests
- `vi.mock("nodemailer")` with `vi.hoisted()` for SMTP tests
- Tool handlers are invoked directly via `dispatchTool` from `@miguelarios/pim-core/mcp`
- Each server has a `src/__tests__/roundtrip.test.ts` that drives a real `@modelcontextprotocol/client` over `InMemoryTransport` on both protocol eras — that's what proves wire conformance (schemas advertised, arguments validated, confirmation round trips)

## Pull Requests

`.github/pull_request_template.md` is the default body — fill its sections and delete the
"Bug fixes only" block when it does not apply. Type-specific emphasis:

- **feat** — what it lets a user do that they could not before, and the design decisions a
  reviewer would otherwise reverse-engineer from the diff (what was rejected, and why).
- **fix** — keep the bug block. Current behaviour, expected behaviour, reproduction. Say what
  the root cause turned out to be, not just the symptom.
- **refactor / chore** — what is equivalent before and after, and what proves it (usually:
  the existing tests, unchanged).
- **docs** — what was wrong or missing. Skip Testing and Release if nothing runs or ships.

Merges are **squash merges**, so:

- The PR **title** becomes the commit subject on `main`, with `(#N)` appended. Use the
  Conventional-Commit form the history already uses: `feat(cal-mcp): …`, `fix(core): …`.
  Title the PR for the *whole* change, not for whichever commit happens to be first.
- The squash **body is built from the branch's commit messages**, not from the PR body. So
  commit messages are permanent and worth writing properly; the PR body is for reviewers.

One PR is one concern. Repo-wide convention changes do not ride along with a feature.

## What not to commit

- **Implementation plans** (step-by-step checklists, progress tracking, `- [ ]` task lists)
  stay out of the repo. Their value expires the moment they are executed, and they
  accumulate. `docs/superpowers/plans/` is legacy — do not add to it.
- **Design docs** (`docs/superpowers/specs/`) are worth keeping: the decisions, trade-offs
  and rejected alternatives stay useful long after the work lands. Commit one **with the
  implementation, in the same PR** — never as a separate earlier commit, which mislabels the
  branch and makes a feature look like a docs change.
- Planning output that is neither of those — scratch notes, exploratory scripts — belongs in
  the session scratchpad, not the repo.

## Publishing

- All 4 packages publish independently to npm under `@miguelarios` scope
- **Merging the release PR is the release.** Bump the version in
  `packages/<pkg>/package.json`, add the matching `## <version> (<date>)` section to that
  package's `CHANGELOG.md`, and merge to `main`. `release.yml` detects the changed version,
  publishes to npm, then pushes the `<package>/v<version>` tag and creates the GitHub Release
  with the changelog section as its notes. No local git client is needed, so a release can be
  finished entirely from the GitHub web UI or a cloud session.
- Publish order is handled automatically: `pim-core` is sorted ahead of the MCP servers
- Pushing a `<package>/v<version>` tag by hand still publishes, via `publish.yml`'s tag trigger.
  Note this path publishes to npm only — the GitHub Release and changelog notes are written by
  `release.yml`, so a hand-pushed tag leaves no Release behind
- If one package in a batch fails to publish, the others are still tagged and released; the failed
  one is skipped with a warning and the run goes red. Re-running the job resumes it, since each
  step checks npm and the existing tag/release before acting
- Publishing is idempotent: a version already on npm is skipped, so a failed run can be re-run
- The version in the tag must match `package.json`, or the publish fails rather than shipping a mismatch
- `.npmignore` excludes test files from published packages
