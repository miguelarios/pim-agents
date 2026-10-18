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
| **Input schemas** | Adding a required parameter, removing or renaming one, making an optional one required, narrowing a type or an `enum`, tightening a format or range, rejecting properties that used to be ignored, or changing what a parameter's default means. |
| **Output schemas** (`structuredContent`) | Removing or renaming a field, changing its type, making a required field optional or nullable, or changing what a value means (units, time zone, encoding, inclusive vs exclusive). Adding or removing a value of an `enum` the server returns (a client matching every value breaks on a new one). |
| **Annotations** | Changing `readOnlyHint`, `destructiveHint` or `idempotentHint`, in either direction. Clients use them to decide what to auto-approve and what to retry, so either direction changes what runs unattended: tightening stops something that used to run, loosening lets something run that used to be held. `openWorldHint` is informational and may change in a minor. |
| **Text result block** | Changing what the JSON text block carries. It mirrors `structuredContent` for clients that do not read structured output, and it is the *only* place an error's `{ error, message, retryable }` appears, since error results have no `structuredContent`. The output-schema and error-code rules apply to it. |
| **Error codes** | Renaming or removing an `error` code, reporting an existing condition under a different code, or making a call that used to succeed fail. The `retryable` flag is part of this: flipping it for a condition changes client retry loops. This covers the codes every server shares through pim-core's MCP facade (`CONFIRMATION_DECLINED`, `CONFIRMATION_UNSUPPORTED`, `UNKNOWN_TOOL`) as well as the pim-core `ErrorCode` values each server returns for its own failures. |
| **Confirmation** | Gating an operation that was not gated (a headless client that cannot answer the prompt starts failing), or no longer gating one that was (it now runs without asking). The same stance as annotations: both directions are breaking. |
| **Configuration** | Renaming or removing an environment variable, changing a default, or changing how a value is parsed. |
| **Transports and protocol** | Dropping stdio or Streamable HTTP, or a supported MCP protocol revision. |
| **Runtime** | Raising the Node.js floor in `engines`. |
| **Resources** | Changing the shape of an `imap://` URI the server hands out, removing or renaming a resource template, or changing the `mimeType` a resource is served as. |

### pim-core

Its contract is the JavaScript API exported from `@miguelarios/pim-core`,
`/ics` and `/mcp`: names, signatures, the shapes of returned objects, thrown
error classes and their `code`s. Anything not exported from those entry points
is internal. pim-core is versioned on its own, and a server's major bump never
requires a pim-core one. The reverse does not hold: the servers pass some of
core's behaviour straight to clients (every server returns core's
`ErrorCode` values as its error codes, every server returns the facade's
confirmation codes, and the confirmation gate itself lives in core), so a core
change that alters a server-visible code, result or gate is a breaking change
for those servers too, and needs their major bump as well as core's.

## Allowed in a minor or patch

- **Minor:** adding a tool; adding an optional input parameter; adding an output
  field (a client must ignore fields it does not know); adding an `enum` value
  to an *input*; adding an error code for a condition that could not arise
  before (a new tool's, a new parameter's); adding an environment variable with
  a default that preserves current behaviour; supporting a new protocol
  revision; changing `openWorldHint`.
- **Patch:** a bug fix that makes behaviour match what the schema, description
  or docs already promise, even when a client relied on the wrong behaviour.
  That includes a misclassified error, with a test for "misclassified": the
  condition had been reported under a code that names a *different* condition
  (an unreachable host as `INTERNAL_ERROR`), and the fix reports it under the
  code that names it, with that code's `retryable`. Moving a condition between
  two codes that both fit it is a change of contract, not a fix.
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

- pim-core should reach 1.0 in the same release wave as the servers, so three
  stable servers do not depend on a `0.x` core.
