/**
 * Valibot output schemas for the contact tools. These drive the `outputSchema`
 * advertised in `tools/list` and validate `structuredContent` before it leaves
 * the server, so a result can never contradict its declared shape.
 *
 * They mirror the `Contact` type from `@miguelarios/pim-core`.
 */
import * as v from "valibot";

const typedValue = v.object({
  type: v.optional(v.string()),
  value: v.string(),
});

const postalAddress = v.object({
  type: v.optional(v.string()),
  street: v.optional(v.string()),
  city: v.optional(v.string()),
  state: v.optional(v.string()),
  postalCode: v.optional(v.string()),
  country: v.optional(v.string()),
});

const socialProfile = v.object({
  type: v.string(),
  handle: v.optional(v.string()),
  url: v.optional(v.string()),
});

/**
 * Mirrors `Contact`, plus `addressBook`: the book the contact was read from,
 * as a display name (or URL for a nameless book) that can be passed straight
 * back as the `addressBook` argument of any contact tool. `summary` detail
 * level omits `photo` and `otherProperties` content.
 */
export const contactSchema = v.object({
  uid: v.string(),
  addressBook: v.optional(v.string()),
  fullName: v.string(),
  firstName: v.optional(v.string()),
  lastName: v.optional(v.string()),
  middleName: v.optional(v.string()),
  namePrefix: v.optional(v.string()),
  nameSuffix: v.optional(v.string()),
  emails: v.array(typedValue),
  phones: v.array(typedValue),
  addresses: v.array(postalAddress),
  urls: v.array(typedValue),
  organization: v.optional(v.string()),
  orgUnits: v.optional(v.array(v.string())),
  title: v.optional(v.string()),
  role: v.optional(v.string()),
  nickname: v.optional(v.string()),
  birthday: v.optional(v.string()),
  categories: v.optional(v.array(v.string())),
  note: v.optional(v.string()),
  socialProfiles: v.optional(v.array(socialProfile)),
  photo: v.optional(v.string()),
  kind: v.optional(v.picklist(["individual", "group"])),
  members: v.optional(v.array(v.string())),
  otherProperties: v.array(v.string()),
});

export const contactListSchema = v.object({
  contacts: v.array(contactSchema),
  count: v.number(),
});

export const writeResultSchema = v.object({
  status: v.picklist(["created", "updated", "deleted"]),
  uid: v.string(),
  fullName: v.optional(v.string()),
});

export const resolveResultSchema = v.variant("status", [
  v.object({
    status: v.literal("resolved"),
    fullName: v.string(),
    email: v.string(),
  }),
  v.object({
    status: v.literal("ambiguous"),
    candidates: v.array(
      v.object({
        fullName: v.string(),
        email: v.string(),
        uid: v.string(),
        addressBook: v.optional(v.string()),
      }),
    ),
  }),
  v.object({
    status: v.literal("not_found"),
    message: v.string(),
  }),
]);

/**
 * Result of moving or copying contacts between address books. Reports per
 * contact rather than a bare count, because a batch can partly succeed:
 * `transferred` names what arrived (with `newUid` for copies, which are given
 * a fresh UID), and `failed` names what did not and why.
 */
export const transferResultSchema = v.object({
  status: v.picklist(["moved", "copied"]),
  from: v.string(),
  to: v.string(),
  transferred: v.array(v.object({ uid: v.string(), newUid: v.optional(v.string()) })),
  failed: v.optional(v.array(v.object({ uid: v.string(), message: v.string() }))),
});
