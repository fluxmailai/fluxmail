import type { Command } from 'commander';

type JsonObject = Record<string, unknown>;

// Public summaries can differ from the instructions sent to MCP clients.
const MCP_DOCUMENTATION: Record<string, { summary: string; body: string }> = {
  send_feedback: {
    summary: 'Submit feedback about Fluxmail with your approval, optional reply address and supported diagnostics.',
    body: 'Submit feedback only when you explicitly ask. Review and approve the message, diagnostics and exact optional reply address before sending. The client must never select a mailbox address automatically or invent diagnostics. Feedback requires authentication but no mail permissions or mailbox access, and remains available after a subscription ends. See [sending feedback](/docs/tools#send-feedback) for consent rules, field limits and submission controls, and [feedback privacy](/docs/telemetry#feedback-you-choose-to-send) for recipients and retention.',
  },
};

export interface ToolReference {
  name: string;
  description?: string;
  inputSchema: JsonObject & { properties?: Record<string, unknown>; required?: string[] };
}

export interface GeneratedReference {
  meta: string;
  pages: Map<string, string>;
  indexSection: string;
}

export function generateMcpReference(
  tools: ToolReference[],
  requirements: ReadonlyMap<string, string[][]>,
  updated: string,
): GeneratedReference {
  const pages = new Map<string, string>();
  for (const tool of tools) {
    pages.set(`${toolSlug(tool.name)}.md`, mcpToolPage(tool, requirements.get(tool.name) ?? [], updated));
  }
  return {
    meta: referenceMeta('MCP tools', pages),
    pages,
    indexSection: [
      '| Tool | Description | Capabilities |',
      '| --- | --- | --- |',
      ...tools.map((tool) => {
        const capabilities = capabilityExpression(requirements.get(tool.name) ?? []);
        return `| [\`${tool.name}\`](/docs/tools/${toolSlug(tool.name)}) | ${markdownCell(MCP_DOCUMENTATION[tool.name]?.summary ?? tool.description ?? '')} | ${capabilities} |`;
      }),
    ].join('\n'),
  };
}

export function generateCliReference(root: Command, updated: string): GeneratedReference {
  const commands = allCommands(root);
  const pages = new Map<string, string>();
  for (const command of commands) pages.set(`${commandSlug(command)}.md`, cliCommandPage(command, updated));
  return {
    meta: referenceMeta('CLI reference', pages),
    pages,
    indexSection: [
      '| Command | Description |',
      '| --- | --- |',
      ...commands.map(
        (command) =>
          `| [\`${commandPath(command)}\`](/docs/cli/${commandSlug(command)}) | ${markdownCell(command.description())} |`,
      ),
    ].join('\n'),
  };
}

function referenceMeta(title: string, pages: Map<string, string>): string {
  return `${JSON.stringify(
    {
      title,
      pagesIndex: 'index',
      defaultOpen: false,
      pages: [...pages.keys()].map((file) => file.slice(0, -3)),
    },
    null,
    2,
  )}\n`;
}

function mcpToolPage(tool: ToolReference, requirements: string[][], updated: string): string {
  const properties = tool.inputSchema.properties ?? {};
  const required = new Set(tool.inputSchema.required ?? []);
  const inputSection = Object.keys(properties).length
    ? [
        '| Name | Required | Type | Details |',
        '| --- | --- | --- | --- |',
        ...Object.entries(properties).map(([name, value]) => {
          const schema = isObject(value) ? value : {};
          return `| \`${name}\` | ${required.has(name) ? 'Yes' : 'No'} | ${schemaType(schema, tool.inputSchema)} | ${markdownCell(schemaDetails(schema) || 'None')} |`;
        }),
      ].join('\n')
    : 'This tool has no inputs.';

  return [
    `---\ntitle: '${yamlString(humanizeIdentifier(tool.name))}'\ndescription: '${yamlString(MCP_DOCUMENTATION[tool.name]?.summary ?? tool.description ?? `Reference for ${tool.name}.`)}'\nupdated: '${updated}'\n---`,
    '',
    '<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->',
    '',
    `\`${tool.name}\``,
    '',
    MCP_DOCUMENTATION[tool.name]?.body ?? tool.description ?? `Reference for ${tool.name}.`,
    '',
    '## Permissions',
    '',
    `Required capabilities: ${capabilityExpression(requirements)}.`,
    '',
    '## Inputs',
    '',
    inputSection,
    '',
    '<details>',
    '<summary>JSON input schema</summary>',
    '',
    '```json',
    JSON.stringify(tool.inputSchema, null, 2),
    '```',
    '',
    '</details>',
    '',
  ].join('\n');
}

function cliCommandPage(command: Command, updated: string): string {
  const commandName = commandPath(command);
  const sections = [
    `---\ntitle: '${yamlString(commandName)}'\ndescription: '${yamlString(command.description())}'\nupdated: '${updated}'\n---`,
    '',
    '<!-- This page is generated from the CLI command definitions. Run pnpm docs:generate to update it. -->',
    '',
    `\`${commandName}\``,
    '',
    command.description(),
    '',
    '## Usage',
    '',
    '```bash',
    commandUsage(command),
    '```',
  ];

  if (command.registeredArguments.length) {
    sections.push(
      '',
      '## Arguments',
      '',
      '| Name | Required | Details | Default |',
      '| --- | --- | --- | --- |',
      ...command.registeredArguments.map((argument) => {
        const name = `${argument.name()}${argument.variadic ? '...' : ''}`;
        return `| \`${name}\` | ${argument.required ? 'Yes' : 'No'} | ${markdownCell(argument.description || 'None')} | ${formatDefault(argument.defaultValue)} |`;
      }),
    );
  }

  sections.push('', '## Options', '');
  if (command.options.length) {
    sections.push(
      '| Option | Required | Details | Default |',
      '| --- | --- | --- | --- |',
      ...command.options.map(
        (option) =>
          `| \`${option.flags}\` | ${option.mandatory ? 'Yes' : 'No'} | ${markdownCell(option.description || 'None')} | ${formatDefault(option.defaultValue)} |`,
      ),
    );
  } else {
    sections.push('This command has no command-specific options.');
  }

  if (command.commands.length) {
    sections.push(
      '',
      '## Subcommands',
      '',
      '| Command | Description |',
      '| --- | --- |',
      ...command.commands.map(
        (child) =>
          `| [\`${commandPath(child)}\`](/docs/cli/${commandSlug(child)}) | ${markdownCell(child.description())} |`,
      ),
    );
  }
  sections.push('');
  return sections.join('\n');
}

function capabilityExpression(requirements: string[][]): string {
  if (!requirements.length || requirements.some((requirement) => !requirement.length)) return 'None';
  return requirements
    .map((requirement) => requirement.map((capability) => `\`${capability}\``).join(' + '))
    .join(' or ');
}

function schemaType(schema: JsonObject, root: JsonObject, resolvedReferences = new Set<string>()): string {
  if (typeof schema.$ref === 'string') {
    const referencedSchema = resolveLocalReference(root, schema.$ref);
    if (!referencedSchema || resolvedReferences.has(schema.$ref)) return '`object`';
    return schemaType(referencedSchema, root, new Set([...resolvedReferences, schema.$ref]));
  }
  if (Array.isArray(schema.enum)) return schema.enum.map((item) => `\`${String(item)}\``).join(' or ');
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf
      .filter(isObject)
      .map((item) => schemaType(item, root, resolvedReferences))
      .join(' or ');
  }
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf
      .filter(isObject)
      .map((item) => schemaType(item, root, resolvedReferences))
      .join(' or ');
  }
  if (Array.isArray(schema.type)) {
    return schema.type
      .filter((type): type is string => typeof type === 'string')
      .map((type) => schemaType({ ...schema, type }, root, resolvedReferences))
      .join(' or ');
  }
  if (schema.type === 'array' && isObject(schema.items)) {
    return `array of ${schemaType(schema.items, root, resolvedReferences)}`;
  }
  return `\`${typeof schema.type === 'string' ? schema.type : 'object'}\``;
}

function resolveLocalReference(root: JsonObject, reference: string): JsonObject | undefined {
  if (!reference.startsWith('#/')) return undefined;
  let current: unknown = root;
  for (const encodedPart of reference.slice(2).split('/')) {
    const part = encodedPart.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
    } else if (isObject(current) && Object.hasOwn(current, part)) {
      current = current[part];
    } else {
      return undefined;
    }
  }
  return isObject(current) ? current : undefined;
}

function schemaDetails(schema: JsonObject): string {
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives) && alternatives.length === 2) {
    const branches = alternatives.filter(isObject);
    const valueSchema = branches.find((branch) => branch.type !== 'null');
    if (valueSchema && branches.some((branch) => branch.type === 'null')) schema = { ...valueSchema, ...schema };
  }
  const details: string[] = [];
  if (typeof schema.description === 'string') details.push(schema.description);
  if (typeof schema.format === 'string') details.push(`Format: \`${schema.format}\`.`);
  if (typeof schema.minLength === 'number') details.push(`Minimum length: ${schema.minLength}.`);
  if (typeof schema.maxLength === 'number') details.push(`Maximum length: ${schema.maxLength}.`);
  if (typeof schema.minimum === 'number') details.push(`Minimum: ${schema.minimum}.`);
  if (typeof schema.maximum === 'number') details.push(`Maximum: ${schema.maximum}.`);
  return details.join(' ');
}

function commandUsage(command: Command): string {
  const suffix = [
    ...command.registeredArguments.map((argument) => {
      const name = `${argument.name()}${argument.variadic ? '...' : ''}`;
      return argument.required ? `<${name}>` : `[${name}]`;
    }),
    ...(command.options.length ? ['[options]'] : []),
    ...(command.commands.length ? ['[command]'] : []),
  ];
  return [commandPath(command), ...suffix].join(' ');
}

function formatDefault(value: unknown): string {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) return 'None';
  return `\`${markdownCell(String(value))}\``;
}

function allCommands(root: Command): Command[] {
  return root.commands.flatMap((command) => [command, ...allCommands(command)]);
}

function commandPath(command: Command): string {
  const parts: string[] = [];
  for (let current: Command | null = command; current; current = current.parent) {
    if (current.name()) parts.unshift(current.name());
  }
  return parts.join(' ');
}

function commandSlug(command: Command): string {
  const names: string[] = [];
  for (let current: Command | null = command; current?.parent; current = current.parent) names.unshift(current.name());
  return names.join('-');
}

function toolSlug(name: string): string {
  return name.replaceAll('_', '-');
}

function humanizeIdentifier(value: string): string {
  const words = value.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function yamlString(value: string): string {
  return value.replaceAll("'", "''");
}

function markdownCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
