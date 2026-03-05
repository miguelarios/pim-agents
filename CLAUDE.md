# CLAUDE.md

## Project Overview

PIM Agents — AI agent tooling for email (IMAP/SMTP), calendar (CalDAV), and contacts (CardDAV).

Monorepo with 4 packages:
- `packages/core` — `@miguelarios/pim-core` — shared config, validation, errors, vCard utilities
- `packages/card-mcp` — `@miguelarios/card-mcp` — CardDAV contacts MCP server (6 tools)
- `packages/email-mcp` — `@miguelarios/email-mcp` — IMAP/SMTP email MCP server (10 tools)
- `packages/cal-mcp` — `@miguelarios/cal-mcp` — (stub, Phase 3)

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

- MCP-first: each server uses `@modelcontextprotocol/sdk` with stdio transport
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
