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
