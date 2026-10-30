/** Fixed labels for MCP clients. Client names are untrusted, so telemetry groups them into these. */
export const mcpClients = [
  'claude',
  'claude_desktop',
  'claude_code',
  'codex',
  'cursor',
  'chatgpt',
  'vscode',
  'windsurf',
  'cline',
  'roo_code',
  'goose',
  'zed',
  'muse',
  'other',
  'unknown',
] as const;
export type McpClient = (typeof mcpClients)[number];

const aliases: ReadonlyMap<string, McpClient> = new Map([
  ['claude', 'claude'],
  ['claude_ai', 'claude'],
  ['claude_desktop', 'claude_desktop'],
  ['claude_code', 'claude_code'],
  ['codex', 'codex'],
  ['codex_mcp_client', 'codex'],
  ['cursor', 'cursor'],
  ['cursor_vscode', 'cursor'],
  ['chatgpt', 'chatgpt'],
  ['openai_mcp', 'chatgpt'],
  ['vscode', 'vscode'],
  ['visual_studio_code', 'vscode'],
  ['windsurf', 'windsurf'],
  ['cline', 'cline'],
  ['roo_code', 'roo_code'],
  ['goose', 'goose'],
  ['zed', 'zed'],
  ['muse', 'muse'],
]);

// Client names are untrusted. Classify them into fixed labels for stable grouping.
export function classifyMcpClient(name: unknown): McpClient {
  if (typeof name !== 'string' || !name.trim()) return 'unknown';
  if (name.length > 128) return 'other';
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[ _-]+/g, '_');
  return aliases.get(normalized) ?? 'other';
}

export interface McpClientProperties {
  mcp_client: McpClient;
  /** The self-reported name, trimmed. Omitted when blank or longer than 128 characters. */
  mcp_client_name?: string;
  /** The self-reported version, trimmed. Omitted when blank or longer than 64 characters. */
  mcp_client_version?: string;
  /** A dated MCP revision such as `2026-07-28`. Omitted when absent or malformed. */
  mcp_protocol_version?: string;
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

/** Describe an untrusted `clientInfo` object and protocol version from a request. */
export function mcpClientProperties(info: unknown, protocolVersion?: unknown): McpClientProperties {
  const client: { name?: unknown; version?: unknown } = info && typeof info === 'object' ? info : {};
  const name = boundedText(client.name, 128);
  const version = boundedText(client.version, 64);
  return {
    mcp_client: classifyMcpClient(client.name),
    ...(name ? { mcp_client_name: name } : {}),
    ...(version ? { mcp_client_version: version } : {}),
    ...(typeof protocolVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(protocolVersion)
      ? { mcp_protocol_version: protocolVersion }
      : {}),
  };
}
