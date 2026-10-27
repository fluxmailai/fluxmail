import { describe, expect, it } from 'vitest';
import { MAIL_SCOPES, PERMISSION_PRESETS, SHARED_TOOLS, sharedTool } from '../src/mcp/index.js';

describe('shared MCP tool contract', () => {
  it('names each tool once and leaves out product-only tools', () => {
    const names = SHARED_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of ['get_status', 'get_connection_status', 'list_scheduled_emails', 'cancel_scheduled_email']) {
      expect(names).not.toContain(name);
    }
  });

  it('gives every tool valid scopes, explicit hints and an object input schema', () => {
    for (const tool of SHARED_TOOLS) {
      expect(MAIL_SCOPES, tool.name).toContain(tool.scope);
      if (tool.alsoRequires) expect(MAIL_SCOPES, tool.name).toContain(tool.alsoRequires);
      expect(Object.keys(tool.annotations), tool.name).toEqual(
        expect.arrayContaining(['readOnlyHint', 'destructiveHint', 'openWorldHint']),
      );
      if (!tool.annotations.readOnlyHint) expect(tool.annotations.idempotentHint, tool.name).toBeTypeOf('boolean');
      expect(tool.inputSchema, tool.name).toMatchObject({ type: 'object', properties: expect.any(Object) });
    }
  });

  it('describes each tool without naming another tool', () => {
    for (const tool of SHARED_TOOLS) {
      for (const other of SHARED_TOOLS) {
        if (other.name !== tool.name)
          expect(tool.description, tool.name).not.toMatch(new RegExp(`\\b${other.name}\\b`));
      }
    }
  });

  it('inlines every input schema without $ref pointers', () => {
    for (const tool of SHARED_TOOLS) expect(JSON.stringify(tool.inputSchema), tool.name).not.toContain('"$ref"');
  });

  it('keeps send-only arguments out of the contract', () => {
    expect(Object.keys(sharedTool('send_email').inputSchema.properties as object)).not.toContain('sendAt');
  });

  it('never grants permanent deletion through a preset', () => {
    for (const scopes of Object.values(PERMISSION_PRESETS)) expect(scopes).not.toContain('mail.delete');
  });
});
