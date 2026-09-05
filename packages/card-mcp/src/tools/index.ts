/**
 * Single source of registration order: contact tools first, then the group
 * tools, then the address book tools. Both wire tests and `main.ts` register from here.
 */
import type { ToolDef } from "@miguelarios/pim-core/mcp";
import type { CardDavService } from "../services/CardDavService.js";
import { ADDRESS_BOOK_TOOLS } from "./addressBookTools.js";
import { CONTACT_TOOLS } from "./contactTools.js";
import { GROUP_TOOLS } from "./groupTools.js";

export { ADDRESS_BOOK_TOOLS } from "./addressBookTools.js";
export { CONTACT_TOOLS } from "./contactTools.js";
export { GROUP_TOOLS } from "./groupTools.js";

export const CARD_TOOLS: ReadonlyArray<ToolDef<CardDavService>> = [
  ...CONTACT_TOOLS,
  ...GROUP_TOOLS,
  ...ADDRESS_BOOK_TOOLS,
];
