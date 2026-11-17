import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNamedPermissionProfile, permissionPolicyForProfile } from '../packages/server/src/permissions.js';
import { sharedToolTarget } from '../packages/core/src/mcp/tools.js';
import { formatWithOxfmt, listServerTools } from './mcp-server-tools.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TEMPLATE = path.join(ROOT, 'mcpb/manifest.template.json');

/**
 * Listing text for tools whose description doesn't start with a short summary a user can read, for example
 * one that names arguments.
 */
const SUMMARIES: Record<string, string> = {
  get_status: 'Check account connections and scheduled sends.',
  list_scheduled_emails: 'List pending and past scheduled sends.',
  cancel_scheduled_email: 'Cancel a pending scheduled send.',
};

/** The first sentence of a tool description, which MCPB clients and Smithery show in their tool list. */
export function summary(name: string, description: string): string {
  const target = sharedToolTarget(name);
  if (target !== name) return `Another name for ${target}.`;
  if (SUMMARIES[name]) return SUMMARIES[name];
  const sentence = description.match(/^.*?[.!?](?=\s|$)/s)?.[0];
  if (!sentence || sentence.length < 12 || sentence.length > 160 || /\b(?:e\.g|i\.e|etc|vs)\.$/.test(sentence)) {
    throw new Error(
      `The description of ${name} doesn't start with a short sentence. Add its listing text to SUMMARIES.`,
    );
  }
  return sentence;
}

async function generateTemplate(current: string): Promise<string> {
  const template = JSON.parse(current) as {
    tools: unknown;
    user_config: { permission_profile: { default: string } };
  };
  // A bundle install gets the tools of the profile its manifest uses by default.
  const profile = template.user_config.permission_profile.default;
  if (!isNamedPermissionProfile(profile)) throw new Error(`Unknown default permission profile ${profile}.`);
  const tools = (await listServerTools(permissionPolicyForProfile(profile))).map((tool) => ({
    name: tool.name,
    description: summary(tool.name, tool.description ?? ''),
  }));
  // oxfmt keeps an object on one line when it starts there, so each short tool entry stays on one line.
  template.tools = tools.map((_, index) => `@@tool${index}@@`);
  const source = JSON.stringify(template, null, 2).replace(/"@@tool(\d+)@@"/g, (_, index: string) => {
    const { name, description } = tools[Number(index)]!;
    return `{ "name": ${JSON.stringify(name)}, "description": ${JSON.stringify(description)} }`;
  });
  return formatWithOxfmt(TEMPLATE, `${source}\n`);
}

async function main(): Promise<void> {
  const current = readFileSync(TEMPLATE, 'utf8');
  const next = await generateTemplate(current);
  if (process.argv.includes('--check')) {
    if (next !== current) {
      throw new Error(`The tool list in ${path.relative(ROOT, TEMPLATE)} is stale. Run pnpm contract:generate.`);
    }
    return;
  }
  if (next !== current) writeFileSync(TEMPLATE, next);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
