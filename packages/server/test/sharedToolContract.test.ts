import { afterEach, describe, expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { MAIL_SCOPES, SHARED_TOOLS, type MailScope } from '@fluxmail/core/mcp';
import type { EmailService } from '../src/service/emailService.js';
import { buildMcpServer } from '../src/mcp/buildServer.js';
import { ALL_MAIL_PERMISSION_POLICY, customPermissionPolicy, type PermissionPolicy } from '../src/permissions.js';

/** Tools only self-hosted Fluxmail offers. */
const PRODUCT_ONLY_TOOLS = ['get_status', 'list_scheduled_emails', 'cancel_scheduled_email'];
/** Arguments self-hosted Fluxmail adds to shared tools. */
const PRODUCT_ONLY_ARGUMENTS: Record<string, string[]> = { send_email: ['sendAt'] };
const PRODUCT_ONLY_RESULT_FIELDS: Record<string, string[]> = {
  send_email: ['scheduleId'],
  forward_email: ['scheduleId'],
  get_delivery_operation: ['scheduleId'],
};

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function listTools(permissions: PermissionPolicy) {
  const server = buildMcpServer({ enforceQuota: () => undefined } as unknown as EmailService, { permissions });
  const client = new Client({ name: 'contract', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return (await client.listTools()).tools;
}

function withoutProductArguments(name: string, schema: Record<string, unknown>): Record<string, unknown> {
  const omitted = PRODUCT_ONLY_ARGUMENTS[name] ?? [];
  const properties = { ...(schema.properties as Record<string, unknown>) };
  for (const key of omitted) delete properties[key];
  const required = ((schema.required as string[] | undefined) ?? []).filter((key) => !omitted.includes(key));
  const { required: _required, ...rest } = schema;
  return { ...rest, properties, ...(required.length ? { required } : {}) };
}

function withoutProductResults(name: string, schema: Record<string, unknown>): Record<string, unknown> {
  const omitted = PRODUCT_ONLY_RESULT_FIELDS[name] ?? [];
  if (!omitted.length) return schema;
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  const data = properties.data!;
  const dataProperties = { ...(data.properties as Record<string, unknown>) };
  for (const key of omitted) delete dataProperties[key];
  const required = ((data.required as string[] | undefined) ?? []).filter((key) => !omitted.includes(key));
  const { required: _required, ...rest } = data;
  return {
    ...schema,
    properties: {
      ...properties,
      data: { ...rest, properties: dataProperties, ...(required.length ? { required } : {}) },
    },
  };
}

const allExcept = (scope: MailScope) => customPermissionPolicy(MAIL_SCOPES.filter((item) => item !== scope));

describe('shared MCP tool contract', () => {
  it('lists every shared tool and only the declared product-only tools', async () => {
    const listed = (await listTools(ALL_MAIL_PERMISSION_POLICY)).map((tool) => tool.name).sort();
    expect(listed).toEqual([...SHARED_TOOLS.map((tool) => tool.name), ...PRODUCT_ONLY_TOOLS].sort());
  });

  it.each(SHARED_TOOLS.map((tool) => [tool.name, tool] as const))('%s matches the contract', async (name, contract) => {
    const advertised = (await listTools(ALL_MAIL_PERMISSION_POLICY)).find((tool) => tool.name === name);
    expect(advertised).toBeDefined();
    expect(advertised!.title).toBe(contract.title);
    expect(advertised!.annotations).toEqual(contract.annotations);
    expect(advertised!.description!.startsWith(contract.description)).toBe(true);
    const schema = advertised!.inputSchema as Record<string, unknown>;
    for (const key of PRODUCT_ONLY_ARGUMENTS[name] ?? []) {
      expect(Object.keys(schema.properties as object)).toContain(key);
    }
    expect(withoutProductArguments(name, schema)).toEqual(contract.inputSchema);
    const output = advertised!.outputSchema as Record<string, unknown>;
    for (const key of PRODUCT_ONLY_RESULT_FIELDS[name] ?? []) {
      expect(Object.keys((output.properties as { data: { properties: object } }).data.properties)).toContain(key);
    }
    expect(withoutProductResults(name, output)).toEqual(contract.outputSchema);
  });

  it.each(SHARED_TOOLS.map((tool) => [tool.name, tool] as const))(
    '%s is gated by its contract scopes',
    async (name, contract) => {
      const required = [
        ...(contract.scope ? [contract.scope] : []),
        ...(contract.alsoRequires ? [contract.alsoRequires] : []),
      ];
      const names = async (policy: PermissionPolicy) => (await listTools(policy)).map((tool) => tool.name);
      expect(await names(customPermissionPolicy(required))).toContain(name);
      for (const scope of required) expect(await names(allExcept(scope))).not.toContain(name);
    },
  );
});
