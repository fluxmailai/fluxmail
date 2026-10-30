export { createContext, type AppContext } from './context.js';
export { createApp } from './http/app.js';
export { createRestApi, type RestApiDeps } from './http/rest.js';
export {
  buildMcpServer,
  type BuildMcpServerOptions,
  type McpServerOptions,
  type McpTransport,
} from './mcp/buildServer.js';
export {
  MCP_CAPABILITIES,
  ADMIN_CAPABILITIES,
  NAMED_PERMISSION_PROFILES,
  FULL_PERMISSION_POLICY,
  ALL_MAIL_PERMISSION_POLICY,
  DEFAULT_PERMISSION_POLICY,
  permissionPolicyForProfile,
  customPermissionPolicy,
  type McpCapability,
  type AdminCapability,
  type Capability,
  type NamedPermissionProfile,
  type PermissionProfile,
  type PermissionPolicy,
} from './permissions.js';
export { EmailService, type SendInput, type ForwardInput } from './service/emailService.js';
export { buildForwardBody } from '@fluxmail/core';
export { AccountRegistry } from './accounts/registry.js';
export {
  loadConfig,
  resolveDataDir,
  resolveStoreLocation,
  createConfigurationService,
  configTomlPath,
  deploymentToml,
  resolveDeploymentConfig,
  writeDeploymentConfig,
  ConfigurationService,
  EnvironmentControlledSettingError,
  CONFIG_REFERENCE,
  SETTING_REGISTRY,
  type FluxmailConfig,
  type FluxmailStoreLocation,
  type DeploymentConfig,
  type ConfigSource,
  type OAuthAppStatus,
  type SettingRegistryEntry,
  type SettingMutability,
} from './config.js';
export {
  openDb,
  inspectStoreCompatibility,
  IncompatibleStoreError,
  CURRENT_STORE_FORMAT,
  MIN_SUPPORTED_STORE_FORMAT,
  MAX_SUPPORTED_STORE_FORMAT,
  type StoreCompatibility,
} from './storage/db.js';
export { VERSION } from './version.js';
export { encryptString, decryptString } from './storage/crypto.js';
export {
  getEntitlements,
  checkLicenseState,
  assertAccountLimit,
  assertMemberLimit,
  assertWithinQuota,
  readLeaseRow,
  saveLeaseToken,
  clearLease,
  PERSONAL_TIER,
  GRACE_PERIOD_MS,
  type Entitlements,
  type LicenseState,
} from './licensing/entitlements.js';
export { addMember, getMember, findMember, listMembers, removeMember, type MemberInfo } from './storage/members.js';
export { verifyLease, licensePublicKeys, PINNED_LICENSE_PUBLIC_KEYS, type LeasePayload } from './licensing/lease.js';
export {
  validateLicense,
  releaseLicense,
  DEFAULT_LICENSE_SERVER_URL,
  LICENSE_KEY_PATTERN,
  type ValidateOutcome,
} from './licensing/client.js';
export {
  refreshLicense,
  startLicenseRefresher,
  loadInstanceId,
  LicenseController,
  type RefreshResult,
  type LicenseControllerOptions,
} from './licensing/refresher.js';
export {
  captureOperation,
  createTelemetry,
  isTelemetryEnabled,
  OPERATION_TELEMETRY_EVENT,
  setTelemetryEnabled,
  telemetryDisabled,
  type OperationOutcome,
  type OperationTelemetry,
  type ProductSurface,
  type Telemetry,
  type TelemetryProperties,
} from './telemetry.js';
export {
  createLogger,
  getLogger,
  logCodedFailure,
  logFailure,
  readLocalLogs,
  shutdownLogging,
  type CreateLoggerOptions,
  type LogContext,
  type LogDestination,
  type LogError,
  type LogLevel,
  type Logger,
  type LogRecord,
  type ProcessMode,
  type ReadLogEntry,
  type ReadLogsOptions,
  type ReadLogsResult,
} from './logging.js';
