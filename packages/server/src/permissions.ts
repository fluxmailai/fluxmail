import { MAIL_SCOPES, PERMISSION_PRESET_NAMES, PERMISSION_PRESETS, type MailScope } from '@fluxmail/core/mcp';

export const MCP_CAPABILITIES = MAIL_SCOPES;

export type McpCapability = MailScope;

export const ADMIN_CAPABILITIES = [
  'admin.accounts',
  'admin.members',
  'admin.api_keys',
  'admin.license',
  'admin.audit',
] as const;
export type AdminCapability = (typeof ADMIN_CAPABILITIES)[number];
export type Capability = McpCapability | AdminCapability;

export const MCP_CAPABILITY_DESCRIPTIONS: Record<McpCapability, string> = {
  'mail.read':
    'List, search, and read mail; inspect status, folders, labels, and sender addresses; list scheduled sends; download attachments.',
  'mail.drafts': 'Create, update, and delete drafts; cancel scheduled sends.',
  'mail.organize': 'Mark read or unread, star, archive, move, and manage labels or Outlook categories.',
  'mail.trash': 'Move messages to or from Trash.',
  'mail.delete': 'Permanently delete messages.',
  'mail.send': 'Send or schedule messages.',
};

export const NAMED_PERMISSION_PROFILES = PERMISSION_PRESET_NAMES;
export type NamedPermissionProfile = (typeof NAMED_PERMISSION_PROFILES)[number];
export type PermissionProfile = NamedPermissionProfile | 'custom';

export const PERMISSION_PROFILE_DESCRIPTIONS: Record<NamedPermissionProfile, string> = {
  'read-only': 'Read and search mail, inspect folders, labels, and scheduled sends, and download attachments.',
  'read-write': 'Read mail, manage drafts, organize messages, and move messages to or from Trash.',
  full: 'Use every Fluxmail email capability except permanent deletion, including sending mail.',
};

export interface PermissionPolicy {
  profile: PermissionProfile;
  capabilities: Capability[];
  /** Administrative capabilities added to a named mail profile. Empty for custom policies. */
  supplementalCapabilities: AdminCapability[];
}

const CAPABILITY_SET = new Set<string>(MCP_CAPABILITIES);
const ADMIN_CAPABILITY_SET = new Set<string>(ADMIN_CAPABILITIES);
const ALL_CAPABILITY_SET = new Set<string>([...MCP_CAPABILITIES, ...ADMIN_CAPABILITIES]);
const PROFILE_SET = new Set<string>(NAMED_PERMISSION_PROFILES);

const PROFILE_CAPABILITIES = PERMISSION_PRESETS;

export const FULL_PERMISSION_POLICY: PermissionPolicy = permissionPolicyForProfile('full');
/** Every email capability, including permanent deletion. */
export const ALL_MAIL_PERMISSION_POLICY: PermissionPolicy = customPermissionPolicy(MCP_CAPABILITIES);
/** Profile for stdio connections and API keys created without permission options. */
export const DEFAULT_PERMISSION_PROFILE: NamedPermissionProfile = 'read-only';
export const DEFAULT_PERMISSION_POLICY: PermissionPolicy = permissionPolicyForProfile(DEFAULT_PERMISSION_PROFILE);

export function isNamedPermissionProfile(value: string): value is NamedPermissionProfile {
  return PROFILE_SET.has(value);
}

export function isMcpCapability(value: string): value is McpCapability {
  return CAPABILITY_SET.has(value);
}

export function isAdminCapability(value: string): value is AdminCapability {
  return ADMIN_CAPABILITY_SET.has(value);
}

export function isCapability(value: string): value is Capability {
  return ALL_CAPABILITY_SET.has(value);
}

export function normalizeAdminCapabilities(capabilities: readonly string[]): AdminCapability[] {
  const unique = [...new Set(capabilities)];
  const invalid = unique.filter((capability) => !isAdminCapability(capability));
  if (invalid.length) {
    throw new Error(
      `Unknown administrative capability: ${invalid.join(', ')}. Expected one of: ${ADMIN_CAPABILITIES.join(', ')}.`,
    );
  }
  return ADMIN_CAPABILITIES.filter((capability) => unique.includes(capability));
}

export function permissionPolicyForProfile(
  profile: NamedPermissionProfile,
  supplementalCapabilities: readonly string[] = [],
): PermissionPolicy {
  const supplemental = normalizeAdminCapabilities(supplementalCapabilities);
  return {
    profile,
    capabilities: [...PROFILE_CAPABILITIES[profile], ...supplemental],
    supplementalCapabilities: supplemental,
  };
}

export function customPermissionPolicy(capabilities: readonly string[]): PermissionPolicy {
  const unique = [...new Set(capabilities)];
  const invalid = unique.filter((capability) => !isCapability(capability));
  if (invalid.length) {
    throw new Error(
      `Unknown capability: ${invalid.join(', ')}. Expected one of: ${[...MCP_CAPABILITIES, ...ADMIN_CAPABILITIES].join(', ')}.`,
    );
  }
  return {
    profile: 'custom',
    capabilities: [...MCP_CAPABILITIES, ...ADMIN_CAPABILITIES].filter((capability) => unique.includes(capability)),
    supplementalCapabilities: [],
  };
}

/** The named profile with exactly these mail capabilities, otherwise a custom policy. */
export function permissionPolicyForMailCapabilities(capabilities: readonly McpCapability[]): PermissionPolicy {
  const wanted = new Set(capabilities);
  const profile = NAMED_PERMISSION_PROFILES.find(
    (name) =>
      PROFILE_CAPABILITIES[name].length === wanted.size && PROFILE_CAPABILITIES[name].every((c) => wanted.has(c)),
  );
  return profile ? permissionPolicyForProfile(profile) : customPermissionPolicy([...wanted]);
}

export function normalizePermissionPolicy(policy: PermissionPolicy): PermissionPolicy {
  if (policy.profile === 'custom') return customPermissionPolicy(policy.capabilities);
  if (!isNamedPermissionProfile(policy.profile)) throw new Error(`Unknown permission profile: ${policy.profile}`);
  return permissionPolicyForProfile(policy.profile, policy.supplementalCapabilities);
}

function parseCapabilityArray(value: string, description: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error(`${description} must be a JSON array of strings.`);
  }
  return parsed;
}

export function deserializePermissionPolicy(
  profile: string,
  customCapabilities: string | null,
  supplementalCapabilities: string | null = null,
): PermissionPolicy {
  if (profile === 'custom') {
    if (customCapabilities === null) throw new Error('Custom permission policy has no capabilities.');
    if (
      supplementalCapabilities !== null &&
      parseCapabilityArray(supplementalCapabilities, 'Supplemental capabilities').length
    ) {
      throw new Error('Custom permission policies cannot store supplemental capabilities.');
    }
    return customPermissionPolicy(parseCapabilityArray(customCapabilities, 'Custom permission capabilities'));
  }
  if (customCapabilities !== null) throw new Error('Named permission profiles cannot store custom capabilities.');
  if (!isNamedPermissionProfile(profile)) throw new Error(`Unknown permission profile: ${profile}`);
  return permissionPolicyForProfile(
    profile,
    supplementalCapabilities === null
      ? []
      : parseCapabilityArray(supplementalCapabilities, 'Supplemental capabilities'),
  );
}

export function serializeCustomCapabilities(policy: PermissionPolicy): string | null {
  const normalized = normalizePermissionPolicy(policy);
  return normalized.profile === 'custom' ? JSON.stringify(normalized.capabilities) : null;
}

export function serializeSupplementalCapabilities(policy: PermissionPolicy): string {
  const normalized = normalizePermissionPolicy(policy);
  return JSON.stringify(normalized.profile === 'custom' ? [] : normalized.supplementalCapabilities);
}

export function hasCapability(policy: PermissionPolicy, capability: Capability): boolean {
  return policy.capabilities.includes(capability);
}

/**
 * CLI options using the smallest named profile that covers the current and requested mail capabilities,
 * with permanent deletion granted separately. Custom policies keep a complete, explicit --allow list.
 */
export function permissionOptionsGranting(policy: PermissionPolicy, missing: readonly Capability[]): string {
  const needed = new Set<Capability>([...policy.capabilities, ...missing]);
  const profileCapabilities = MCP_CAPABILITIES.filter(
    (capability) => capability !== 'mail.delete' && needed.has(capability),
  );
  const profile =
    policy.profile === 'custom'
      ? undefined
      : NAMED_PERMISSION_PROFILES.find((name) =>
          profileCapabilities.every((capability) => PROFILE_CAPABILITIES[name].includes(capability)),
        );
  if (!profile) {
    return [...MCP_CAPABILITIES, ...ADMIN_CAPABILITIES]
      .filter((capability) => needed.has(capability))
      .map((capability) => `--allow ${capability}`)
      .join(' ');
  }
  const extra = MCP_CAPABILITIES.filter(
    (capability) => needed.has(capability) && !PROFILE_CAPABILITIES[profile].includes(capability),
  );
  const admin = ADMIN_CAPABILITIES.filter((capability) => needed.has(capability));
  return [
    `--profile ${profile}`,
    ...extra.map((capability) => `--allow ${capability}`),
    ...admin.map((capability) => `--admin ${capability}`),
  ].join(' ');
}

/** Where a connection's permissions come from, which decides how to change them. */
export type PermissionSource = { kind: 'stdio' } | { kind: 'api_key'; keyId: string } | { kind: 'oauth' };

/** Instructions for adding the missing capabilities to a connection. */
export function enableCapabilitiesInstructions(
  policy: PermissionPolicy,
  missing: readonly Capability[],
  source: PermissionSource | undefined,
): string {
  if (!source) return 'To enable it, change the Fluxmail permissions for this connection.';
  if (source.kind === 'oauth') {
    return (
      'To enable it, disconnect Fluxmail in the MCP client, connect again, and select the permission ' +
      'on the Fluxmail approval page.'
    );
  }
  const options = permissionOptionsGranting(policy, missing);
  return source.kind === 'stdio'
    ? `To enable it, start "fluxmail stdio ${options}" in the MCP client configuration, ` +
        'replacing any existing --profile or --allow options, then restart the client.'
    : `To enable it, an administrator can run "fluxmail apikey permissions ${source.keyId} ${options}".`;
}
