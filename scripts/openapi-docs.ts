const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const;

type JsonObject = Record<string, unknown>;

interface OpenApiDocument extends JsonObject {
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: { schemas?: Record<string, JsonObject> };
}

interface OpenApiOperation extends JsonObject {
  operationId?: string;
  summary?: string;
  description?: string;
  security?: Array<Record<string, string[]>>;
  parameters?: OpenApiParameter[];
  requestBody?: JsonObject;
  responses?: Record<string, OpenApiResponse>;
}

interface OpenApiParameter extends JsonObject {
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
  schema?: JsonObject;
}

interface OpenApiResponse extends JsonObject {
  description?: string;
  content?: Record<string, { schema?: JsonObject }>;
}

export interface GeneratedRestApiReference {
  meta: string;
  pages: Map<string, string>;
  indexSection: string;
}

interface ReferenceOperation {
  apiPath: string;
  method: (typeof HTTP_METHODS)[number];
  operation: OpenApiOperation;
  group: string;
}

const RESOURCE_TITLES: Record<string, string> = {
  accounts: 'Accounts',
  connections: 'Accounts',
  connection: 'Accounts',
  imap: 'Accounts',
  'api-keys': 'API keys',
  attachments: 'Attachments',
  'audit-events': 'Audit events',
  'delivery-operations': 'Delivery operations',
  drafts: 'Drafts',
  folders: 'Folders',
  labels: 'Labels',
  license: 'License',
  me: 'Members',
  members: 'Members',
  messages: 'Messages',
  'oauth-apps': 'OAuth applications',
  'oauth-connections': 'OAuth connections',
  'scheduled-sends': 'Scheduled sends',
  'send-as': 'Sender addresses',
  send: 'Sending',
  forward: 'Sending',
  status: 'Server',
  threads: 'Threads',
};

function operationGroup(apiPath: string): string {
  const segments = apiPath
    .split('/')
    .slice(3)
    .filter((segment) => !segment.startsWith('{'));
  if (segments[0] === 'auth' || (segments[0] === 'me' && ['password', 'sessions'].includes(segments[1] ?? ''))) {
    return 'Authentication';
  }
  const resource = segments.findLast((segment) => Object.hasOwn(RESOURCE_TITLES, segment));
  if (resource) return RESOURCE_TITLES[resource]!;
  const fallback = segments[0];
  return fallback ? fallback.charAt(0).toUpperCase() + fallback.slice(1).replaceAll('-', ' ') : 'Server';
}

export function generateRestApiReference(document: OpenApiDocument, updated: string): GeneratedRestApiReference {
  const operations: ReferenceOperation[] = [];
  for (const [apiPath, pathItem] of Object.entries(document.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (operation) operations.push({ apiPath, method, operation, group: operationGroup(apiPath) });
    }
  }
  operations.sort(
    (left, right) =>
      left.group.localeCompare(right.group) ||
      HTTP_METHODS.indexOf(left.method) - HTTP_METHODS.indexOf(right.method) ||
      left.apiPath.localeCompare(right.apiPath),
  );

  const pages = new Map<string, string>();
  const navigation: string[] = [];
  let currentGroup: string | undefined;
  for (const { apiPath, method, operation, group } of operations) {
    if (group !== currentGroup) {
      navigation.push(`---${group}---`);
      currentGroup = group;
    }
    const slug = operationSlug(operation, method, apiPath);
    navigation.push(slug);
    pages.set(`${slug}.md`, operationPage(document, method, apiPath, operation, updated));
  }
  return {
    meta: `${JSON.stringify(
      {
        title: 'REST API',
        pagesIndex: 'index',
        defaultOpen: false,
        pages: navigation,
      },
      null,
      2,
    )}\n`,
    pages,
    indexSection: endpointIndex(operations),
  };
}

function endpointIndex(operations: ReferenceOperation[]): string {
  const lines: string[] = [];
  let currentGroup: string | undefined;
  for (const { apiPath, method, operation, group } of operations) {
    if (group !== currentGroup) {
      if (lines.length) lines.push('');
      lines.push(`### ${group}`, '', '| Endpoint | Description |', '| --- | --- |');
      currentGroup = group;
    }
    const slug = operationSlug(operation, method, apiPath);
    const title = operationTitle(method, apiPath);
    const description = operation.description ?? operation.summary ?? title;
    lines.push(`| [\`${markdownCell(title)}\`](/docs/rest-api/${slug}) | ${markdownCell(description)} |`);
  }
  return lines.join('\n');
}

function operationSlug(operation: OpenApiOperation, method: string, apiPath: string): string {
  const source = operation.operationId ?? `${method}-${apiPath}`;
  return source
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function operationTitle(method: string, apiPath: string): string {
  return `${method.toUpperCase()} ${apiPath}`;
}

function operationPage(
  document: OpenApiDocument,
  method: string,
  apiPath: string,
  operation: OpenApiOperation,
  updated: string,
): string {
  const title = operationTitle(method, apiPath);
  const description = operation.description ?? `Reference for ${method.toUpperCase()} ${apiPath}.`;
  const requestBody = requestBodySchema(operation);
  const sections: string[] = [
    `---\ntitle: '${yamlString(title)}'\ndescription: '${yamlString(description)}'\nupdated: '${updated}'\n---`,
    '',
    '<!-- This page is generated from the OpenAPI schema. Run pnpm docs:generate to update it. -->',
    '',
    description,
    '',
    authenticationSection(apiPath, operation),
    '',
    requestSection(document, method, apiPath, operation, requestBody),
  ];
  const retrySafety = retrySafetySection(operation);
  if (retrySafety) sections.push('', retrySafety);
  sections.push('', responseSection(document, operation), '');
  return sections.join('\n');
}

function yamlString(value: string): string {
  return value.replaceAll("'", "''");
}

function authenticationSection(apiPath: string, operation: OpenApiOperation): string {
  if (!operation.security?.length) return '## Authentication\n\nThis endpoint does not require authentication.';
  if (usesSecurityScheme(operation, 'memberSessionAuth')) {
    return [
      '## Authentication',
      '',
      'Pass a Fluxmail member session as a bearer token. API keys cannot use this endpoint.',
    ].join('\n');
  }
  if (apiPath.startsWith('/api/v1/admin/')) {
    return [
      '## Authentication',
      '',
      'Pass an administrator member session or an API key as a bearer token. The key must belong to an administrator and include the capability listed above.',
      '',
      'Remote administrative requests require HTTPS. Requests from the local computer can use HTTP.',
    ].join('\n');
  }
  return [
    '## Authentication',
    '',
    'Pass a Fluxmail member session or API key as a bearer token. API keys apply their mailbox scope and permissions to the request.',
  ].join('\n');
}

function usesSecurityScheme(operation: OpenApiOperation, scheme: string): boolean {
  return operation.security?.some((requirement) => scheme in requirement) ?? false;
}

function requestSection(
  document: OpenApiDocument,
  method: string,
  apiPath: string,
  operation: OpenApiOperation,
  bodySchema: JsonObject | undefined,
): string {
  const parameters = operation.parameters ?? [];
  const lines = ['## Request', '', curlExample(document, method, apiPath, operation, bodySchema)];
  if (!parameters.length && !bodySchema) {
    lines.push('', 'This endpoint has no parameters or request body.');
    return lines.join('\n');
  }
  if (parameters.length) {
    lines.push(
      '',
      '### Parameters',
      '',
      '| Name | Location | Required | Type | Details |',
      '| --- | --- | --- | --- | --- |',
      ...parameters.map((parameter) => {
        const schema = parameter.schema ?? {};
        const schemaDescription = typeof schema.description === 'string' ? schema.description : undefined;
        const description = parameter.description ?? schemaDescription;
        const details = [description, schemaDetails(schema, false)].filter(Boolean).join(' ');
        return `| \`${parameter.name ?? ''}\` | ${parameter.in ?? ''} | ${parameter.required ? 'Yes' : 'No'} | ${schemaType(schema)} | ${markdownCell(details || 'None')} |`;
      }),
    );
  }
  if (bodySchema) {
    const contentType = requestBodyContentType(operation) ?? 'application/json';
    lines.push(
      '',
      '### Request body',
      '',
      `Content type: \`${contentType}\``,
      '',
      schemaDetailsBlock(document, bodySchema),
    );
  }
  return lines.join('\n');
}

function curlExample(
  document: OpenApiDocument,
  method: string,
  apiPath: string,
  operation: OpenApiOperation,
  bodySchema: JsonObject | undefined,
): string {
  const urlPath = apiPath.replace(/\{([^}]+)\}/g, (_match, name: string) =>
    pathParameterExample(name, operation.parameters ?? []),
  );
  const lines = [`curl 'http://localhost:8977${urlPath}'`];
  if (method !== 'get') lines.push(`  -X ${method.toUpperCase()}`);
  if (operation.security?.length) {
    const token = usesSecurityScheme(operation, 'memberSessionAuth') ? '$FLUXMAIL_SESSION' : '$FLUXMAIL_API_KEY';
    lines.push(`  -H "Authorization: Bearer ${token}"`);
  }
  for (const parameter of operation.parameters ?? []) {
    if (parameter.in !== 'header' || !parameter.name) continue;
    const value = parameter.name.toLowerCase() === 'idempotency-key' ? '$(uuidgen)' : parameterExample(parameter);
    lines.push(`  -H "${parameter.name}: ${value}"`);
  }
  if (bodySchema) {
    lines.push(`  -H "Content-Type: ${requestBodyContentType(operation) ?? 'application/json'}"`);
    lines.push(`  --data '${JSON.stringify(exampleForSchema(document, bodySchema), null, 2)}'`);
  }
  return `\`\`\`bash\n${lines.map((line, index) => `${line}${index < lines.length - 1 ? ' \\' : ''}`).join('\n')}\n\`\`\``;
}

function pathParameterExample(name: string, parameters: OpenApiParameter[]): string {
  const parameter = parameters.find((candidate) => candidate.in === 'path' && candidate.name === name);
  const explicit = parameter?.schema?.example;
  if (typeof explicit === 'string' || typeof explicit === 'number') return encodeURIComponent(String(explicit));
  const examples: Record<string, string> = {
    accountId: 'acct_123',
    messageId: 'msg_123',
    threadId: 'thread_123',
    draftId: 'draft_123',
    scheduleId: 'schedule_123',
    attachmentId: 'attachment_123',
  };
  return examples[name] ?? `${name}_123`;
}

function parameterExample(parameter: OpenApiParameter): string {
  const example = parameter.schema?.example;
  return typeof example === 'string' || typeof example === 'number' ? String(example) : 'value';
}

function requestBodyContentType(operation: OpenApiOperation): string | undefined {
  const content =
    isObject(operation.requestBody) && isObject(operation.requestBody.content)
      ? operation.requestBody.content
      : undefined;
  return content ? Object.keys(content)[0] : undefined;
}

function requestBodySchema(operation: OpenApiOperation): JsonObject | undefined {
  const contentType = requestBodyContentType(operation);
  if (!contentType || !isObject(operation.requestBody) || !isObject(operation.requestBody.content)) return undefined;
  const media = operation.requestBody.content[contentType];
  return isObject(media) && isObject(media.schema) ? media.schema : undefined;
}

function retrySafetySection(operation: OpenApiOperation): string | undefined {
  const hasIdempotencyKey = operation.parameters?.some(
    (parameter) => parameter.in === 'header' && parameter.name?.toLowerCase() === 'idempotency-key',
  );
  if (!hasIdempotencyKey) return undefined;
  return [
    '## Safe retries',
    '',
    'Fluxmail scopes each delivery key to the authenticated credential. Delivery operations and their keys have no automatic expiry.',
    '',
    '- Repeating a request with the same key and request data returns the stored delivery operation. It does not send again.',
    '- Reusing the key with different request data returns `409 idempotency_conflict`.',
    '- An `uncertain` operation may have been delivered. Fluxmail does not retry it automatically.',
    '',
    'Save the key with the request and reuse it if the response is lost. Look up the operation status before taking further action. For an `uncertain` result, check the Sent folder or recipient before creating a new delivery request.',
    '',
    'REST keys created before the delivery-operation upgrade keep their original 24 hour lifetime. A retry with one of those keys may return the legacy response shape and `Idempotency-Replayed: true`.',
  ].join('\n');
}

function responseSection(document: OpenApiDocument, operation: OpenApiOperation): string {
  const responses = operation.responses ?? {};
  const lines = [
    '## Responses',
    '',
    '| Status | Description | Content type |',
    '| --- | --- | --- |',
    ...Object.entries(responses).map(([status, response]) => {
      const contentTypes = Object.keys(response.content ?? {});
      return `| \`${status}\` | ${markdownCell(response.description ?? '')} | ${contentTypes.map((item) => `\`${item}\``).join(', ') || 'None'} |`;
    }),
  ];
  for (const [status, response] of Object.entries(responses)) {
    const statusCode = Number(status);
    if (statusCode < 200 || statusCode >= 300) continue;
    const content = Object.entries(response.content ?? {}).filter((entry) => entry[1].schema);
    for (const [contentType, media] of content) {
      const heading = content.length === 1 ? `${status} response` : `${status} ${contentType} response`;
      lines.push('', `### ${heading}`, '', schemaDetailsBlock(document, media.schema!));
    }
  }
  return lines.join('\n');
}

function schemaDetailsBlock(document: OpenApiDocument, schema: JsonObject): string {
  const resolved = resolveSchema(document, schema, new Set());
  return [
    '<details>',
    '<summary>JSON schema</summary>',
    '',
    '```json',
    JSON.stringify(resolved, null, 2),
    '```',
    '',
    '</details>',
  ].join('\n');
}

function resolveSchema(document: OpenApiDocument, value: unknown, seen: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveSchema(document, item, seen));
  if (!isObject(value)) return value;
  if (typeof value.$ref === 'string') {
    const name = value.$ref.split('/').at(-1);
    if (!name || seen.has(name)) return value;
    const schema = document.components?.schemas?.[name];
    if (!schema) return value;
    return resolveSchema(document, schema, new Set([...seen, name]));
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveSchema(document, item, seen)]));
}

function exampleForSchema(document: OpenApiDocument, schema: JsonObject, seen = new Set<string>()): unknown {
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.split('/').at(-1);
    if (!name || seen.has(name)) return {};
    const target = document.components?.schemas?.[name];
    return target ? exampleForSchema(document, target, new Set([...seen, name])) : {};
  }
  const alternatives = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined;
  if (alternatives?.length && isObject(alternatives[0])) return exampleForSchema(document, alternatives[0], seen);
  if (schema.type === 'array' && isObject(schema.items)) return [exampleForSchema(document, schema.items, seen)];
  if (schema.type === 'object' || isObject(schema.properties)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    const required = new Set(
      Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : [],
    );
    return Object.fromEntries(
      Object.entries(properties)
        .filter(([name]) => required.has(name))
        .map(([name, property]) => [name, isObject(property) ? exampleForSchema(document, property, seen) : null]),
    );
  }
  if (schema.type === 'boolean') return true;
  if (schema.type === 'integer') {
    if (typeof schema.minimum === 'number') return Math.ceil(schema.minimum);
    if (typeof schema.exclusiveMinimum === 'number') return Math.floor(schema.exclusiveMinimum) + 1;
    return 0;
  }
  if (schema.type === 'number') {
    if (typeof schema.minimum === 'number') return schema.minimum;
    if (typeof schema.exclusiveMinimum === 'number') return schema.exclusiveMinimum + 1;
    return 0;
  }
  if (schema.format === 'email') return 'person@example.com';
  if (schema.format === 'date') return '2026-07-15';
  if (schema.format === 'date-time') return '2026-07-15T14:00:00Z';
  if (schema.format === 'byte') return 'SGVsbG8=';
  return 'string';
}

function schemaType(schema: JsonObject): string {
  if (typeof schema.$ref === 'string') return `\`${schema.$ref.split('/').at(-1) ?? 'object'}\``;
  if (Array.isArray(schema.enum)) return schema.enum.map((item) => `\`${String(item)}\``).join(' or ');
  if (schema.type === 'array' && isObject(schema.items)) return `array of ${schemaType(schema.items)}`;
  return `\`${typeof schema.type === 'string' ? schema.type : 'object'}\``;
}

function schemaDetails(schema: JsonObject, includeDescription = true): string {
  const details: string[] = [];
  if (includeDescription && typeof schema.description === 'string') details.push(schema.description);
  if (typeof schema.format === 'string') details.push(`Format: \`${schema.format}\`.`);
  if (typeof schema.minLength === 'number') details.push(`Minimum length: ${schema.minLength}.`);
  if (typeof schema.maxLength === 'number') details.push(`Maximum length: ${schema.maxLength}.`);
  if (typeof schema.minimum === 'number') details.push(`Minimum: ${schema.minimum}.`);
  if (typeof schema.maximum === 'number') details.push(`Maximum: ${schema.maximum}.`);
  if (typeof schema.pattern === 'string') details.push(`Pattern: \`${schema.pattern}\`.`);
  return details.join(' ');
}

function markdownCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
