/**
 * Valibot output schemas for the group tools. A group is a vCard with
 * `KIND:group`; these shapes expose it as a group rather than as a contact
 * that happens to carry member UIDs.
 */
import * as v from "valibot";

const groupSummary = v.object({
  uid: v.string(),
  name: v.string(),
  memberCount: v.number(),
  addressBook: v.string(),
});

export const groupListSchema = v.object({
  groups: v.array(groupSummary),
  count: v.number(),
});

/** A member, resolved to its contact. `email` is the contact's first address. */
const groupMember = v.object({
  uid: v.string(),
  fullName: v.string(),
  email: v.optional(v.string()),
});

/**
 * `missingMembers` lists member UIDs the book no longer holds — a member
 * deleted without the group being edited leaves a dangling reference, which
 * is worth reporting rather than silently dropping.
 */
export const groupDetailSchema = v.object({
  uid: v.string(),
  name: v.string(),
  addressBook: v.string(),
  members: v.array(groupMember),
  missingMembers: v.array(v.string()),
});

export const groupWriteResultSchema = v.object({
  status: v.picklist(["created", "updated", "deleted"]),
  uid: v.string(),
  name: v.string(),
  memberCount: v.optional(v.number()),
});
