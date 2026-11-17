import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { buildMcpServer } from '../packages/server/src/mcp/buildServer.js';
import type { PermissionPolicy } from '../packages/server/src/permissions.js';

export type ServerTool = Awaited<ReturnType<Client['listTools']>>['tools'][number];

/** The tools/list response of a self-hosted MCP server with the given permissions, for the generators. */
export async function listServerTools(permissions: PermissionPolicy): Promise<ServerTool[]> {
  const server = buildMcpServer({ enforceQuota: () => undefined } as never, { permissions });
  const client = new Client({ name: 'fluxmail-generator', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}
