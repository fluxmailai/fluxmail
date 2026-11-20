import type { McpCapability } from '../permissions.js';

/**
 * Scopes for the tools only this product offers. Shared tools take theirs from the contract. The MCP bundle check
 * reads this module from the built bundle.
 */
export const PRODUCT_TOOL_SCOPES: Readonly<Record<string, McpCapability>> = {
  get_status: 'mail.read',
  // It writes files, so read-only connections don't get it. It also needs mail.read, checked where it registers.
  save_attachment: 'mail.drafts',
};
