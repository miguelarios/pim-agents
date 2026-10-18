# Versioning policy

All four packages follow [Semantic Versioning](https://semver.org/). This page
says what that means for an MCP server, whose public surface is mostly read by
programs (MCP clients and the models driving them) rather than imported as code.

## Before 1.0

While a package is `0.x`, a **minor** bump may break things and a **patch** bump
does not. Every break is called out in that package's `CHANGELOG.md` under the
version that introduces it.

## From 1.0: what is the contract

A change to any of the following needs a **major** version, unless the
"Allowed in a minor or patch" section below says otherwise.

### Each server

| Surface | Breaking |
| --- | --- |
| **Tool names** | Renaming or removing a tool. |
| **Input schemas** | Removing a parameter, renaming one, making an optional one required, narrowing a type or an `enum`, tightening a format or range, or changing what a parameter's default means. |
| **Output schemas** (`structuredContent`) | Removing or renaming a field, changing its type, making a required field optional or nullable, or changing what a value means (units, time zone, encoding, inclusive vs exclusive). Removing a value from an `enum` the server returns. |
| **Annotations** | Changing `readOnlyHint` from `true` to `false`, `destructiveHint` from `false` to `true`, or `idempotentHint` from `true` to `false`. Clients use these to decide what to auto-approve, so tightening them changes what runs unattended. |
| **Text result block** | Changing what the JSON text block carries. It mirrors `structuredContent` for clients that do not read structured output, and it is the *only* place an error's `{ error, message, retryable }` appears, since error results have no `structuredContent`. The output-schema and error-code rules apply to it. |
| **Error codes** | Renaming or removing an `error` code, or reporting an existing condition under a different code. The `retryable` flag is part of this: flipping it for a condition changes client retry loops. |
| **Confirmation** | Gating an operation that was not gated (a headless client that cannot answer the prompt starts failing), or no longer gating one that was. |
| **Configuration** | Renaming or removing an environment variable, changing a default, or changing how a value is parsed. |
| **Transports and protocol** | Dropping stdio or Streamable HTTP, or a supported MCP protocol revision. |
| **Runtime** | Raising the Node.js floor in `engines`, which every package declares. |
| **Resource URIs** | Changing the shape of an `imap://` URI the server hands out. |

### pim-core

Its contract is the JavaScript API exported from `@miguelarios/pim-core`,
`/ics` and `/mcp`: names, signatures, the shapes of returned objects, thrown
error classes and their `code`s. Anything not exported from those entry points
is internal. pim-core is versioned on its own, but a server's major bump never
requires a pim-core major bump, nor the reverse.

## Allowed in a minor or patch

- **Minor:** adding a tool; adding an optional input parameter; adding an output
  field (a client must ignore fields it does not know); adding an `enum` value
  to an *input*; adding an error code for a condition that previously
  succeeded or never arose; adding an environment variable with a default that
  preserves current behaviour; supporting a new protocol revision; loosening an
  annotation (the opposite of the breaking direction above).
- **Patch:** a bug fix that makes behaviour match what the schema, description
  or docs already promise, even when a client relied on the wrong behaviour.
  Correcting a misclassified error (an unreachable host reported as an internal
  error) is a fix, not a change of contract.
- **Free to change at any time:** tool `description` and `title` text, server
  `instructions`, the human-readable `message` of an error, the formatting
  (whitespace, key order) of the JSON text block, the order of tools in
  `tools/list` (it is stable between calls, not across versions), log output,
  and performance characteristics.

Model-facing text is free to change, but it still steers behaviour: a
description edit that tells the model to use a tool differently gets a
changelog entry, even though it needs no major bump.

## Before tagging 1.0

These parts of the surface are inconsistent today and become hard to change
after 1.0:

- **Error codes differ between servers.** cal-mcp maps every failure to
  `not_found`, `validation_error` or `backend_error`. email-mcp and card-mcp
  return pim-core's `ErrorCode` values directly (`CONNECTION_FAILED`,
  `CONTACT_NOT_FOUND`, …). Pick one vocabulary for all three, or document both
  as the contract, before the servers reach 1.0.
- **Every package declares `engines`.** The Runtime row binds only packages that
  declare a floor; on `main` today only email-mcp does.
- **Node.js 20 is past end of life.** Raising the floor to 22 costs a major
  bump after 1.0, and nothing before it.
- pim-core should reach 1.0 in the same release wave as the servers, so three
  stable servers do not depend on a `0.x` core.
