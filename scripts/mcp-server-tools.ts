import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { buildMcpServer } from '../packages/server/src/mcp/buildServer.js';
import { AttachmentFolder } from '../packages/server/src/mcp/attachmentFolder.js';
import type { PermissionPolicy } from '../packages/server/src/permissions.js';

export type ServerTool = Awaited<ReturnType<Client['listTools']>>['tools'][number];

/**
 * The tools/list response of a self-hosted MCP server with the given permissions, for the generators. With
 * stdio, the server also has the tools and arguments of a stdio connection's attachment folder.
 */
export async function listServerTools(
  permissions: PermissionPolicy,
  { stdio = false }: { stdio?: boolean } = {},
): Promise<ServerTool[]> {
  // A fixed folder outside the home directory, so descriptions name it without a path on every machine. Listing
  // tools never reads it.
  const server = buildMcpServer({ enforceQuota: () => undefined } as never, {
    permissions,
    ...(stdio ? { attachmentFolder: AttachmentFolder.planned('/fluxmail-generator/attachments') } : {}),
  });
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

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Formats generated source the way `pnpm format` would format the file it's written to. */
export function formatWithOxfmt(file: string, source: string): string {
  return execFileSync(path.join(ROOT, 'node_modules/.bin/oxfmt'), [`--stdin-filepath=${file}`], {
    cwd: ROOT,
    input: source,
    encoding: 'utf8',
  });
}
