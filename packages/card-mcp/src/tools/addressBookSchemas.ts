/**
 * Valibot output schemas for the address book tools, mirroring the shapes in
 * `docs/superpowers/specs/2026-08-24-card-mcp-address-books-design.md`.
 *
 * A book has no UID, so these deliberately do not reuse `writeResultSchema` —
 * widening the contact result's status across two unrelated resource types
 * would make both less legible.
 */
import * as v from "valibot";

export const addressBookListSchema = v.object({
  addressBooks: v.array(
    v.object({
      displayName: v.string(),
      url: v.string(),
      description: v.optional(v.string()),
      ctag: v.optional(v.string()),
      syncToken: v.optional(v.string()),
      contactCount: v.optional(v.number()),
    }),
  ),
  count: v.number(),
});

export const addressBookWriteResultSchema = v.object({
  status: v.picklist(["created", "renamed", "deleted"]),
  url: v.string(),
  displayName: v.optional(v.string()),
});
