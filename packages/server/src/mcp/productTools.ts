import type { McpCapability } from '../permissions.js';

/**
 * Scopes for the tools only this product offers. Shared tools take theirs from the contract. The MCP bundle check
 * reads this module from the built bundle.
 */
export const PRODUCT_TOOL_SCOPES: Readonly<Record<string, McpCapability>> = {
  get_status: 'mail.read',
};
