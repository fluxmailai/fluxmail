import { describe, expect, it } from 'vitest';
import { createRestApi, REST_OPENAPI_DOCUMENT } from '../packages/server/src/http/rest.js';
import { generateRestApiReference } from './openapi-docs.js';

describe('OpenAPI documentation generation', () => {
  it('documents every endpoint purpose and the current administrative capabilities', () => {
    const document = createRestApi({} as never).getOpenAPIDocument(REST_OPENAPI_DOCUMENT);
    const reference = generateRestApiReference(document, '2026-10-28');
    const capabilities = {
      members: 'admin.members',
      accounts: 'admin.accounts',
      connections: 'admin.accounts',
      imap: 'admin.accounts',
      'oauth-apps': 'admin.accounts',
      'api-keys': 'admin.api_keys',
      'oauth-connections': 'admin.api_keys',
      license: 'admin.license',
      'audit-events': 'admin.audit',
    };

    for (const [apiPath, pathItem] of Object.entries(document.paths)) {
      for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
        const operation = pathItem[method];
        if (!operation) continue;
        expect(operation.description, `${method} ${apiPath}`).toBeTruthy();
        if (apiPath.startsWith('/api/v1/admin/')) {
          const group = apiPath.split('/')[4] as keyof typeof capabilities;
          expect(capabilities[group], apiPath).toBeDefined();
          expect(operation.description).toContain(`Requires ${capabilities[group]}.`);
        }
      }
    }
    for (const page of reference.pages.values()) {
      expect(page).not.toContain('Reference for ');
    }
    expect(reference.pages.get('create-member.md')).toContain('Requires admin.members.');
    expect(reference.pages.get('list-audit-events.md')).toContain('Requires admin.audit.');
  });

  it('uses explicit examples and respects numeric minimums', () => {
    const reference = generateRestApiReference(
      {
        paths: {
          '/api/v1/explicit': {
            post: {
              operationId: 'createExplicitItem',
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        permissionProfile: { type: 'string' },
                      },
                      required: ['name'],
                      example: { name: 'reporting', permissionProfile: 'read-only' },
                    },
                  },
                },
              },
              responses: { 200: { description: 'Created' } },
            },
          },
          '/api/v1/bounded': {
            post: {
              operationId: 'createBoundedItem',
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: { port: { type: 'integer', minimum: 1 } },
                      required: ['port'],
                    },
                  },
                },
              },
              responses: { 200: { description: 'Created' } },
            },
          },
        },
      },
      '2026-07-15',
    );

    expect(reference.pages.get('create-explicit-item.md')).toContain(
      '"name": "reporting",\n  "permissionProfile": "read-only"',
    );
    expect(reference.pages.get('create-bounded-item.md')).toContain('"port": 1');
  });

  it('keeps parameter patterns inside their Markdown table cell', () => {
    const reference = generateRestApiReference(
      {
        paths: {
          '/api/v1/items': {
            get: {
              operationId: 'listItems',
              parameters: [
                {
                  name: 'pageSize',
                  in: 'query',
                  schema: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$' },
                },
              ],
              responses: { 200: { description: 'Items' } },
            },
          },
        },
      },
      '2026-07-15',
    );

    const page = reference.pages.get('list-items.md');
    expect(page).toContain('Pattern: `^(?:[1-9]\\|[1-9][0-9]\\|100)$`.');
    expect(page).not.toContain('[1-9]\\\\|[1-9][0-9]');
  });

  it('uses explicit path parameter examples in curl commands', () => {
    const reference = generateRestApiReference(
      {
        paths: {
          '/api/v1/oauth-apps/{provider}': {
            put: {
              operationId: 'putOAuthApp',
              parameters: [
                {
                  name: 'provider',
                  in: 'path',
                  required: true,
                  schema: { type: 'string', enum: ['google', 'outlook'], example: 'google' },
                },
              ],
              responses: { 200: { description: 'Updated' } },
            },
          },
        },
      },
      '2026-07-15',
    );

    expect(reference.pages.get('put-oauth-app.md')).toContain("curl 'http://localhost:8977/api/v1/oauth-apps/google'");
  });

  it('documents safe retries and every successful response schema', () => {
    const reference = generateRestApiReference(
      {
        paths: {
          '/api/v1/items': {
            post: {
              operationId: 'createItem',
              parameters: [
                {
                  name: 'Idempotency-Key',
                  in: 'header',
                  required: true,
                  description: 'Reuse this key for the same request.',
                  schema: { type: 'string', description: 'Reuse this key for the same request.' },
                },
              ],
              responses: {
                200: {
                  description: 'Created now',
                  content: { 'application/json': { schema: { type: 'object', title: 'CreatedItem' } } },
                },
                202: {
                  description: 'Scheduled',
                  content: { 'application/json': { schema: { type: 'object', title: 'ScheduledItem' } } },
                },
              },
            },
          },
        },
      },
      '2026-07-15',
    );

    const page = reference.pages.get('create-item.md');
    expect(page?.match(/Reuse this key for the same request\./g)).toHaveLength(1);
    expect(page).toContain('## Safe retries');
    expect(page).toContain('no automatic expiry');
    expect(page).toContain('returns the stored delivery operation');
    expect(page).toContain('check the Sent folder or recipient');
    expect(page).toContain('### 200 response');
    expect(page).toContain('"title": "CreatedItem"');
    expect(page).toContain('### 202 response');
    expect(page).toContain('"title": "ScheduledItem"');
  });

  it('distinguishes public, session-only, and administrative authentication', () => {
    const reference = generateRestApiReference(
      {
        paths: {
          '/api/v1': {
            get: { operationId: 'discover', responses: { 200: { description: 'OK' } } },
          },
          '/api/v1/me/password': {
            put: {
              operationId: 'changePassword',
              security: [{ memberSessionAuth: [] }],
              responses: { 200: { description: 'OK' } },
            },
          },
          '/api/v1/admin/members': {
            get: {
              operationId: 'listMembers',
              security: [{ bearerAuth: [] }],
              responses: { 200: { description: 'OK' } },
            },
          },
        },
      },
      '2026-07-15',
    );

    expect(reference.pages.get('discover.md')).toContain('This endpoint does not require authentication.');
    expect(reference.pages.get('change-password.md')).toContain('API keys cannot use this endpoint.');
    expect(reference.pages.get('change-password.md')).toContain('Bearer $FLUXMAIL_SESSION');
    expect(reference.pages.get('list-members.md')).toContain('administrator member session or an API key');
  });
});
