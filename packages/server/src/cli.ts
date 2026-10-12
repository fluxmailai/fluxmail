#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { serve } from '@hono/node-server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { EmailError, isEmailError } from '@fluxmail/core';
import { createContext } from './context.js';
import { RuntimeLifecycle } from './lifecycle.js';
import {
  configTomlPath,
  createConfigurationService,
  deploymentToml,
  readLoggingSettings,
  resolveDataDir,
  resolveStoreLocation,
  writeDeploymentConfig,
} from './config.js';
import { migrateConfigurationFile, parseEnvContent, recognizedMigrationSettings } from './configMigration.js';
import { createApp } from './http/app.js';
import { buildMcpServer } from './mcp/buildServer.js';
import { runLoopbackFlow } from './accounts/googleAuth.js';
import type { LoopbackFlowOptions, OAuthAuthUrlContext } from './accounts/oauthCallback.js';
import { runMicrosoftLoopbackFlow } from './accounts/microsoftAuth.js';
import { IMAP_CONNECTION_TEST_TIMEOUT_MS } from './accounts/registry.js';
import {
  assertHostedConnectionReady,
  prepareHostedGmailConnection,
  prepareHostedOutlookConnection,
  selectGmailConnectionMode,
  validateAccountConnectionFlags,
} from './accounts/gmailConnection.js';
import { listApiKeys, type ApiKeyInfo } from './storage/apiKeys.js';
import { findMember } from './storage/members.js';
import { LICENSE_KEY_PATTERN } from './licensing/client.js';
import { checkLicenseState, getEntitlements, type Entitlements } from './licensing/entitlements.js';
import { VERSION } from './version.js';
import {
  inspectStoreCompatibility,
  MIN_SUPPORTED_STORE_FORMAT,
  openDb,
  openReadonlyDb,
  type FluxmailDb,
} from './storage/db.js';
import type { ImapSecurity } from '@fluxmail/provider-imap';
import {
  customPermissionPolicy,
  ADMIN_CAPABILITIES,
  DEFAULT_PERMISSION_POLICY,
  DEFAULT_PERMISSION_PROFILE,
  isNamedPermissionProfile,
  MCP_CAPABILITIES,
  NAMED_PERMISSION_PROFILES,
  permissionPolicyForProfile,
  type PermissionPolicy,
} from './permissions.js';
import {
  captureOperation,
  getTelemetry,
  installTelemetryStreamEndHandler,
  isTelemetryEnabled,
  setTelemetryEnabled,
  shutdownTelemetry,
  telemetryDisabledInAnyEnvironment,
  type Telemetry,
  type TelemetryProperties,
} from './telemetry.js';
import {
  apiErrorCode,
  apiRequestId,
  clearSessionToken,
  instanceClient,
  loadInstanceConfig,
  removeInstance,
  resolveInstance,
  resolveStdioInstance,
  saveLocalInstance,
  saveRemoteInstance,
  saveSessionToken,
  setRequestDeadlineMs,
  useInstance,
} from './cliInstances.js';
import { cliExitCode, parseOutputFormat, printOutput } from './cliOutput.js';
import { CliStartupError, cliStartupDiagnostics } from './cliStartupDiagnostics.js';
import {
  authenticateBearer,
  isBootstrapComplete,
  normalizeAndValidatePassword,
  recoverAdminPassword,
  setupInitialAdmin,
} from './auth.js';
import { recordAdminAuditEvent } from './storage/adminAudit.js';
import { canManageOwnedAccount } from './authorization.js';
import { createCliUpdateNotifier, type CliUpdateNotifier, type CliUpdateNotifierFactory } from './updateNotifier.js';
import { registerMailCommands } from './cliMail.js';
import {
  accountInventoryProperties,
  connectionFailureKind,
  configuredOAuthAppKind,
  connectionProperties,
  instanceUsageProperties,
  type ConnectionStage,
} from './accounts/telemetry.js';
import {
  flushLogging,
  escapeLogTextForConsole,
  getLogger,
  logCodedFailure,
  logFailure,
  readLocalLogs,
  shutdownLogging,
  type Logger,
  type LogLevel,
} from './logging.js';

interface AddAccountOptions {
  reauthorize?: string;
  local?: boolean;
  hosted?: boolean;
  email?: string;
  displayName?: string;
  imapHost?: string;
  imapPort: string;
  imapSecurity: string;
  imapUser?: string;
  imapPasswordEnv?: string;
  smtpHost?: string;
  smtpPort: string;
  smtpSecurity: string;
  smtpUser?: string;
  smtpPasswordEnv?: string;
  sentFolder?: string;
  draftsFolder?: string;
  trashFolder?: string;
  archiveFolder?: string;
  spamFolder?: string;
  saveSent: boolean;
}

interface PermissionOptions {
  profile?: string;
  allow: string[];
  admin?: string[];
}

interface ScopedMcpOptions extends PermissionOptions {
  account: string[];
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function accountIdsFromRefs(ctx: ReturnType<typeof createContext>, refs: readonly string[]): string[] | null {
  return refs.length ? [...new Set(refs.map((ref) => ctx.registry.findAccount(ref).id))] : null;
}

export function permissionPolicyFromOptions(opts: PermissionOptions, requireSelection = false): PermissionPolicy {
  try {
    const supplemental = opts.admin ?? [];
    if (!opts.profile && opts.allow.length && supplemental.length) {
      throw new Error(
        '--admin can only be combined with a named --profile. Put admin capabilities in --allow for a custom policy.',
      );
    }
    if (opts.profile) {
      if (!isNamedPermissionProfile(opts.profile)) {
        throw new Error(`Unknown profile "${opts.profile}". Expected one of: ${NAMED_PERMISSION_PROFILES.join(', ')}.`);
      }
      const named = permissionPolicyForProfile(opts.profile, supplemental);
      // --allow adds capabilities to the profile, which makes the result a custom policy.
      return opts.allow.length ? customPermissionPolicy([...named.capabilities, ...opts.allow]) : named;
    }
    if (opts.allow.length) return customPermissionPolicy(opts.allow);
    if (supplemental.length) return permissionPolicyForProfile(DEFAULT_PERMISSION_PROFILE, supplemental);
    if (requireSelection) throw new Error('Choose --profile or at least one --allow capability.');
    return DEFAULT_PERMISSION_POLICY;
  } catch (error) {
    throw new EmailError('invalid_request', error instanceof Error ? error.message : String(error));
  }
}

export function permissionPolicyForUpdate(
  opts: PermissionOptions,
  existing: Pick<ApiKeyInfo, 'permissionProfile'>,
): PermissionPolicy {
  const supplemental = opts.admin ?? [];
  if (opts.profile || opts.allow.length) return permissionPolicyFromOptions(opts, true);
  if (!supplemental.length) throw new Error('Choose --profile, --admin, or at least one --allow capability.');
  if (existing.permissionProfile === 'custom') {
    throw new Error('This key uses a custom policy. Pass every capability with --allow.');
  }
  return permissionPolicyForProfile(existing.permissionProfile, supplemental);
}

function connectionPort(value: string, option: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new EmailError('invalid_request', `${option} must be an integer between 1 and 65535.`);
  }
  return port;
}

function connectionSecurity(value: string, option: string): ImapSecurity {
  if (value !== 'tls' && value !== 'starttls') {
    throw new EmailError('invalid_request', `${option} must be "tls" or "starttls".`);
  }
  return value;
}

async function hiddenPrompt(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new EmailError(
      'invalid_request',
      `${label} requires an interactive terminal or an explicit non-interactive input.`,
    );
  }
  const wasFlowing = process.stdin.readableFlowing === true;
  emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdout.write(`${label}: `);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      process.stdin.off('keypress', onKeypress);
      process.stdin.setRawMode(wasRaw);
      if (!wasFlowing) process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onKeypress = (input: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === 'c') return finish(new Error('Canceled'));
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (key.name === 'backspace') {
        if (value) {
          value = value.slice(0, -1);
          process.stdout.write('\b \b');
        }
        return;
      }
      if (key.ctrl || !input) return;
      value += input;
      process.stdout.write('*'.repeat([...input].length));
    };
    process.stdin.on('keypress', onKeypress);
  });
}

async function textPrompt(label: string): Promise<string> {
  if (!process.stdin.isTTY) throw new EmailError('invalid_request', `${label} must be supplied as an option.`);
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await prompt.question(`${label}: `)).trim();
  } finally {
    prompt.close();
  }
}

async function loginPassword(label = 'Password'): Promise<string> {
  return process.env.FLUXMAIL_PASSWORD ?? hiddenPrompt(label);
}

async function newPassword(
  label: string,
  member: Parameters<typeof normalizeAndValidatePassword>[1],
  prompt: (label: string) => Promise<string>,
): Promise<string> {
  return withNewPassword(label, member, prompt, async (password) => password);
}

async function withNewPassword<T>(
  label: string,
  member: Parameters<typeof normalizeAndValidatePassword>[1],
  prompt: (label: string) => Promise<string>,
  submit: (password: string) => Promise<T>,
): Promise<T> {
  const configured = process.env.FLUXMAIL_PASSWORD;
  if (configured !== undefined) return submit(normalizeAndValidatePassword(configured, member));
  for (;;) {
    const password = await prompt(label);
    try {
      return await submit(normalizeAndValidatePassword(password, member));
    } catch (error) {
      if (!(error instanceof EmailError) || error.code !== 'invalid_request') throw error;
      console.error(`Error: ${error.message}`);
    }
  }
}

async function accountSecret(envName: string | undefined, label: string): Promise<string> {
  if (!envName) return hiddenPrompt(label);
  const value = process.env[envName];
  if (!value) throw new EmailError('invalid_request', `${envName} is not set or is empty.`);
  return value;
}

function readSecretFile(file: string): string {
  const value = readFileSync(file === '-' ? 0 : file, 'utf8').replace(/\r?\n$/, '');
  if (!value) throw new EmailError('invalid_request', 'The secret input is empty.');
  return value;
}

async function secretInput(file: string | undefined, label: string): Promise<string> {
  return file === undefined ? hiddenPrompt(label) : readSecretFile(file);
}

/** Print the consent URL and explain how to finish when the redirect cannot reach this computer. */
function printLoopbackInstructions(
  provider: 'gmail' | 'outlook',
  url: string,
  context: OAuthAuthUrlContext,
  port: number,
): void {
  const providerName = provider === 'gmail' ? 'Google' : 'Microsoft';
  const access = provider === 'gmail' ? 'Gmail access' : 'Microsoft mail access';
  console.log(`\nOpen this URL in your browser to authorize ${access}:\n`);
  console.log(`  ${url}\n`);
  if (!context.listening) {
    console.log(
      `Port ${port} is already in use, so Fluxmail cannot receive the redirect from ${providerName}.\n\n` +
        'If Fluxmail is running with Docker Compose, press Ctrl-C and connect the account inside the container ' +
        'so it is saved there:\n\n' +
        `  docker compose exec fluxmail fluxmail accounts add ${provider}\n\n` +
        "Otherwise, approve access, then copy the full URL from your browser's address bar and paste it here.",
    );
    return;
  }
  console.log(`Waiting for ${providerName} to redirect back...`);
  if (context.pasteEnabled) {
    console.log(
      'If your browser runs on another computer, the page will not load after you approve access. ' +
        'Copy the full URL from its address bar and paste it here.',
    );
  }
}

/** Accept a pasted callback URL when a person is at the terminal, and report how the callback arrived. */
function loopbackFlowOptions(program: Command, provider: 'gmail' | 'outlook'): LoopbackFlowOptions {
  return {
    ...(process.stdin.isTTY ? { paste: { input: process.stdin, write: (message) => console.error(message) } } : {}),
    onCallback: (callback) => recordCliOperationProperties(program, connectionProperties({ provider, callback })),
  };
}

/** Offered when a configured public URL, not an explicit --hosted, chose the hosted flow. */
const LOOPBACK_FLOW_REMEDY = 'Pass --local to use the loopback flow on this computer instead.';

function planLine(ent: Entitlements): string {
  const members = `${ent.maxMembers} member${ent.maxMembers === 1 ? '' : 's'}`;
  return `${ent.plan} (up to ${ent.maxAccounts} mailboxes, ${members})`;
}

/** Renewal warning for an expiring or lapsed license; printed by every command that opens the db. */
function warnLicense(db: FluxmailDb, log: (line: string) => void = console.error): void {
  const { warning } = checkLicenseState(db);
  if (warning) log(`Warning: ${warning}`);
}

export interface CliProgramOptions {
  telemetry?: Telemetry;
  updateNotifierFactory?: CliUpdateNotifierFactory;
  passwordPrompt?: (label: string) => Promise<string>;
}

interface ActiveCliOperation {
  telemetry: Telemetry;
  operation: string;
  startedAt: number;
  initialExitCode: number | string | null | undefined;
  logger: Logger;
  properties?: TelemetryProperties;
}

const activeCliOperations = new WeakMap<Command, ActiveCliOperation>();
const activeUpdateNotifiers = new WeakMap<Command, CliUpdateNotifier>();

/** Attach safe, aggregate properties to the telemetry event for the running command. */
function recordCliOperationProperties(program: Command, properties: TelemetryProperties): void {
  const active = activeCliOperations.get(program);
  if (active) active.properties = { ...active.properties, ...properties };
}

/** Read local mailbox state without letting telemetry affect the command. */
async function inspectLocalRegistry<T>(
  inspect: (registry: ReturnType<typeof createContext>['registry']) => T,
): Promise<T | undefined> {
  let context: ReturnType<typeof createContext> | undefined;
  try {
    context = createContext();
    return inspect(context.registry);
  } catch {
    return undefined;
  } finally {
    if (context) {
      try {
        await context.registry.close();
      } catch {
        // Telemetry cleanup must not affect the command.
      }
      try {
        (context.db as unknown as { $client: { close(): void } }).$client.close();
      } catch {
        // Telemetry cleanup must not affect the command.
      }
    }
  }
}

function finishCliOperation(program: Command, outcome: 'success' | 'error', errorCode?: string, error?: unknown): void {
  const active = activeCliOperations.get(program);
  if (!active) return;
  activeCliOperations.delete(program);
  if (active.operation === 'accounts add' && outcome === 'error') {
    const status = apiHttpStatus(error);
    const connectionStage = apiConnectionStage(error);
    active.properties = {
      ...active.properties,
      failure_kind: connectionFailureKind(errorCode ?? 'internal', status, error instanceof TypeError),
      ...(status === undefined ? {} : { http_status: status }),
      ...(connectionStage ? { connection_stage: connectionStage } : {}),
    };
  }
  const startupProperties =
    active.operation === 'stdio' && outcome === 'error'
      ? {
          startup_phase: active.properties?.startup_phase,
          startup_data_dir_source: active.properties?.startup_data_dir_source,
          startup_instance_selection: active.properties?.startup_instance_selection,
          ...cliStartupDiagnostics(error),
        }
      : {};
  if (outcome === 'error') {
    const connectionDetails =
      active.operation === 'accounts add'
        ? {
            request_id: apiRequestId(error),
            connection_stage: active.properties?.connection_stage,
            failure_kind: active.properties?.failure_kind,
            http_status: active.properties?.http_status,
          }
        : undefined;
    const details = {
      ...(active.operation === 'stdio' ? startupProperties : {}),
      ...connectionDetails,
    };
    const context = {
      productSurface: 'cli' as const,
      operation: active.operation,
      skipConsole: true,
      ...(Object.values(details).some((value) => value !== undefined) ? { details } : {}),
    };
    if (error !== undefined) logFailure(active.logger, 'cli.operation_failed', error, context);
    else
      logCodedFailure(
        active.logger,
        'cli.operation_failed',
        errorCode ?? 'command_failed',
        'CLI command failed',
        context,
      );
  }
  captureOperation(active.telemetry, {
    productSurface: 'cli',
    operation: active.operation,
    outcome,
    durationMs: performance.now() - active.startedAt,
    errorCode,
    properties: { ...active.properties, ...startupProperties },
  });
}

function apiHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('status' in error)) return undefined;
  const status = error.status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 0 && status <= 599 ? status : undefined;
}

function apiConnectionStage(error: unknown): ConnectionStage | undefined {
  if (!error || typeof error !== 'object' || !('connectionStage' in error)) return undefined;
  const stage = error.connectionStage;
  return typeof stage === 'string' &&
    ['server_validation', 'provider_check', 'account_persist', 'oauth_prepare', 'complete'].includes(stage)
    ? (stage as ConnectionStage)
    : undefined;
}

/** End a failed command with the error's own telemetry code instead of a generic one. */
function failCliOperation(program: Command, error: unknown, prefix = 'Error: '): void {
  const code = apiErrorCode(error);
  finishCliOperation(program, 'error', code, error);
  let format: 'json' | 'table' | 'ndjson' = 'json';
  try {
    format = parseOutputFormat(program.opts<{ format?: string }>().format ?? 'json');
  } catch {
    // Report an invalid --format value in the default structured format.
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    format === 'table'
      ? `${prefix}${message}`
      : JSON.stringify({
          error: { code, message, ...(apiRequestId(error) ? { requestId: apiRequestId(error) } : {}) },
        }),
  );
  process.exitCode = cliExitCode(code);
}

export function waitForServerListening(server: ReturnType<typeof serve>): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
  });
}

interface EndEventSource {
  once(event: 'end', listener: () => void): unknown;
}

async function shutdownTelemetryThenLogging(): Promise<void> {
  try {
    await shutdownTelemetry();
  } finally {
    await shutdownLogging();
  }
}

export async function shutdownTelemetryAndLogging(): Promise<void> {
  const initialLogFlush = flushLogging().catch(() => {});
  try {
    await shutdownTelemetry();
  } finally {
    await initialLogFlush;
    await shutdownLogging();
  }
}

export function installStdioShutdownHandler(stream: EndEventSource): void {
  installTelemetryStreamEndHandler(stream, shutdownTelemetryThenLogging);
}

/** Build the command tree without parsing arguments or running command actions. */
export function createCliProgram(options: CliProgramOptions = {}): Command {
  const program = new Command();
  program
    .name('fluxmail')
    .description('Fluxmail, a self-hosted email API with MCP, REST, and CLI access')
    .option('--instance <name>', 'Use a named local or remote instance')
    .option('-a, --mail-account <id-or-email>', 'Use an email account by ID or address')
    .option('--format <format>', 'Output format: json, table, or ndjson', 'json')
    .option('--timeout <seconds>', 'Request deadline in seconds (1 to 300)', '30')
    .option('--no-update-notifier', 'Skip the automatic update check for this command')
    .version(VERSION, '-v, --version');

  const selectedInstance = (): string | undefined => program.opts<{ instance?: string }>().instance;
  const selectedAccount = (): string | undefined => program.opts<{ mailAccount?: string }>().mailAccount;
  const selectedFormat = () => parseOutputFormat(program.opts<{ format: string }>().format);
  const capturedOutput = new Map<Command, { original: typeof console.log; lines: string[] }>();

  function commandPath(command: Command): string {
    const names: string[] = [];
    for (let current: Command | null = command; current?.parent; current = current.parent)
      names.unshift(current.name());
    return names.join(' ');
  }

  let telemetrySignalHandlersInstalled = false;
  const TELEMETRY_SIGNAL_SHUTDOWN_TIMEOUT_MS = 1_000;

  /** Flush queued telemetry and local logs before restoring Node's default signal behavior. */
  function installTelemetrySignalHandlers(): void {
    if (telemetrySignalHandlersInstalled) return;
    telemetrySignalHandlersInstalled = true;

    const shutdownAndResignal = (signal: NodeJS.Signals): void => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      process.off('SIGHUP', onSighup);
      let resignaled = false;
      const resignal = (): void => {
        if (resignaled) return;
        resignaled = true;
        process.kill(process.pid, signal);
      };
      const timeout = setTimeout(resignal, TELEMETRY_SIGNAL_SHUTDOWN_TIMEOUT_MS);
      void shutdownTelemetryAndLogging().finally(() => {
        clearTimeout(timeout);
        resignal();
      });
    };
    const onSigint = (): void => shutdownAndResignal('SIGINT');
    const onSigterm = (): void => shutdownAndResignal('SIGTERM');
    const onSighup = (): void => shutdownAndResignal('SIGHUP');

    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    process.once('SIGHUP', onSighup);
  }

  program.hook('preAction', (_command, actionCommand) => {
    selectedFormat();
    setRequestDeadlineMs(Number(program.opts<{ timeout: string }>().timeout) * 1000);
    const command = commandPath(actionCommand);
    const updateNotifierEnabled = program.opts<{ updateNotifier: boolean }>().updateNotifier;
    if (updateNotifierEnabled && actionCommand.name() !== 'stdio') {
      try {
        const notifier = options.updateNotifierFactory?.();
        if (notifier) activeUpdateNotifiers.set(program, notifier);
      } catch {
        // Update checks must not affect command execution.
      }
    }
    // Respect the opt-out before creating a telemetry client or recording this command.
    if (command === 'telemetry disable') return;
    let telemetryEnvironment: NodeJS.ProcessEnv | undefined;
    let telemetryDataDir: string | undefined;
    if (command === 'config migrate') {
      const migration = actionCommand.opts<{ from?: string }>();
      if (migration.from) {
        try {
          const values = parseEnvContent(readFileSync(path.resolve(migration.from), 'utf8'));
          if (values.FLUXMAIL_DATA_DIR !== undefined) {
            telemetryDataDir = resolveDataDir({
              env: { ...process.env, FLUXMAIL_DATA_DIR: values.FLUXMAIL_DATA_DIR },
            });
          }
          if (telemetryDisabledInAnyEnvironment(process.env, values)) {
            telemetryEnvironment = { ...process.env, FLUXMAIL_TELEMETRY: '0' };
          }
        } catch {
          // The command action reports file and parsing errors.
        }
      }
    }
    const dataDir = telemetryDataDir ?? resolveDataDir();
    let logging: ReturnType<typeof readLoggingSettings>;
    try {
      logging = readLoggingSettings(dataDir);
    } catch {
      // Keep recovery and remote commands available when logging configuration is invalid.
      logging = { level: 'info', destination: 'both' };
    }
    const mode = actionCommand.name() === 'serve' ? 'serve' : actionCommand.name() === 'stdio' ? 'stdio' : 'cli';
    activeCliOperations.set(program, {
      telemetry: options.telemetry ?? getTelemetry(dataDir, telemetryEnvironment),
      operation: command,
      startedAt: performance.now(),
      initialExitCode: process.exitCode,
      logger: getLogger(dataDir, mode, logging),
    });
    const [group, action] = command.split(' ');
    const alreadyStructured =
      ['folders', 'labels', 'emails', 'threads', 'drafts', 'scheduled', 'attachments'].includes(group ?? '') ||
      command === 'accounts list' ||
      command === 'status';
    const interactive =
      ['setup', 'login', 'serve', 'stdio', 'scheduled run'].includes(command) ||
      group === 'auth' ||
      command === 'accounts add' ||
      command === 'accounts configure' ||
      command === 'license activate' ||
      (group === 'oauth' && action !== 'status') ||
      group === 'logs';
    if (selectedFormat() !== 'table' && !alreadyStructured && !interactive) {
      const original = console.log;
      const lines: string[] = [];
      capturedOutput.set(program, { original, lines });
      console.log = (...values: unknown[]) => {
        lines.push(values.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' '));
      };
    }
  });

  program.hook('postAction', async (_command, actionCommand) => {
    const captured = capturedOutput.get(program);
    if (captured) {
      capturedOutput.delete(program);
      console.log = captured.original;
      if (captured.lines.length) {
        let data: unknown = captured.lines.length === 1 ? captured.lines[0] : captured.lines;
        if (captured.lines.length === 1) {
          try {
            data = JSON.parse(captured.lines[0]!);
          } catch {
            /* Plain output stays a string. */
          }
        }
        printOutput({ data }, selectedFormat());
      }
    }
    const active = activeCliOperations.get(program);
    const failed =
      active !== undefined &&
      process.exitCode !== active.initialExitCode &&
      process.exitCode !== undefined &&
      process.exitCode !== 0;
    finishCliOperation(program, failed ? 'error' : 'success', failed ? 'command_failed' : undefined);
    try {
      if (
        actionCommand.name() !== 'serve' &&
        actionCommand.name() !== 'stdio' &&
        commandPath(actionCommand) !== 'scheduled run'
      ) {
        await Promise.all([options.telemetry ? Promise.resolve() : shutdownTelemetry(), shutdownLogging()]);
      }
    } finally {
      const notifier = activeUpdateNotifiers.get(program);
      activeUpdateNotifiers.delete(program);
      try {
        notifier?.notify();
      } catch {
        // Update notices must not affect the command outcome.
      }
    }
  });

  program
    .command('setup')
    .description('Create the first local administrator or claim a migrated administrator')
    .option('--name <name>', 'Administrator name')
    .option('--email <email>', 'Administrator email')
    .option('--existing-admin <member>', 'Existing administrator id or email for a migrated instance')
    .action(async (opts: { name?: string; email?: string; existingAdmin?: string }) => {
      try {
        const earlyContext = createContext();
        if (isBootstrapComplete(earlyContext.db)) {
          throw new EmailError(
            'invalid_request',
            'This instance has already been set up. Run "fluxmail --instance local login" to log in to the existing instance.',
          );
        }
        const name = opts.name ?? (opts.existingAdmin ? undefined : await textPrompt('Administrator name'));
        const email = opts.email ?? (await textPrompt('Administrator email'));
        const context = earlyContext;
        const passwordMember = opts.existingAdmin
          ? { ...findMember(context.db, opts.existingAdmin), email }
          : { name: name ?? '', email };
        const password = await newPassword('New password', passwordMember, options.passwordPrompt ?? hiddenPrompt);
        const result = await setupInitialAdmin(context.db, {
          ...(name ? { name } : {}),
          email,
          password,
          ...(opts.existingAdmin ? { existingAdmin: opts.existingAdmin } : {}),
          deviceName: `CLI on ${hostname()}`,
        });
        saveLocalInstance('local');
        saveSessionToken('local', result.session.token);
        recordAdminAuditEvent(context.db, {
          operation: 'auth.setup',
          outcome: 'success',
          actorMemberId: result.member.id,
          actorSessionId: result.session.info.id,
        });
        console.log(`Fluxmail is ready. Logged in to local as ${result.member.name}.`);
      } catch (err) {
        failCliOperation(program, err);
      }
    });

  program
    .command('login')
    .description('Log in to a local or remote instance')
    .option('--server <url>', 'Add or update a remote instance')
    .option('--email <email>', 'Member email')
    .option('--enroll', 'Use a one-time enrollment code')
    .option('--reset', 'Use a one-time password reset code')
    .action(async (opts: { server?: string; email?: string; enroll?: boolean; reset?: boolean }) => {
      try {
        if (opts.enroll && opts.reset) {
          throw new EmailError('invalid_request', '--enroll and --reset cannot be used together.');
        }
        const requestedInstance = selectedInstance();
        const instanceConfig = loadInstanceConfig();
        if (
          !opts.server &&
          !instanceConfig.instances.local &&
          (requestedInstance === 'local' || (!requestedInstance && Object.keys(instanceConfig.instances).length === 0))
        ) {
          saveLocalInstance('local');
        }
        const instanceName = requestedInstance ?? (opts.server ? 'remote' : resolveInstance().name);
        if (opts.server) saveRemoteInstance(instanceName, opts.server);
        const client = instanceClient(instanceName, false);
        const deviceName = `CLI on ${hostname()}`;
        const result =
          opts.enroll || opts.reset
            ? await (async () => {
                const token =
                  (opts.reset ? process.env.FLUXMAIL_RESET_CODE : process.env.FLUXMAIL_INVITE_CODE) ??
                  (await hiddenPrompt(opts.reset ? 'Password reset code' : 'Enrollment code'));
                return withNewPassword('New password', undefined, options.passwordPrompt ?? hiddenPrompt, (password) =>
                  client.json<{ token: string; member: { name: string } }>(
                    opts.reset ? '/api/v1/auth/password-reset' : '/api/v1/auth/enroll',
                    {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ token, password, deviceName }),
                    },
                    false,
                  ),
                );
              })()
            : await client.json<{ token: string; member: { name: string } }>(
                '/api/v1/auth/login',
                {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({
                    email: opts.email ?? (await textPrompt('Email')),
                    password: await loginPassword(),
                    deviceName,
                  }),
                },
                false,
              );
        saveSessionToken(instanceName, result.token);
        useInstance(instanceName);
        console.log(`Logged in to ${instanceName} as ${result.member.name}.`);
      } catch (err) {
        failCliOperation(program, err);
      }
    });

  program
    .command('logout')
    .description('Revoke the current CLI session')
    .action(async () => {
      try {
        const selected = resolveInstance(selectedInstance());
        const response = await instanceClient(selected.name).request('/api/v1/auth/logout', { method: 'POST' });
        if (!response.ok && response.status !== 401) {
          throw new EmailError('invalid_request', `Logout failed with HTTP ${response.status}.`);
        }
        clearSessionToken(selected.name);
        console.log(`Logged out of ${selected.name}.`);
      } catch (err) {
        failCliOperation(program, err);
      }
    });

  const instances = program.command('instances').description('Manage local and remote CLI instances');
  instances
    .command('list')
    .description('List configured instances')
    .action(() => {
      const config = loadInstanceConfig();
      const rows = Object.entries(config.instances).map(([name, profile]) => ({
        name,
        active: config.active === name ? '*' : '',
        kind: profile.kind,
        url: profile.kind === 'remote' ? profile.serverUrl : '',
      }));
      const width = (values: string[]): number => Math.max(...values.map((value) => value.length));
      const nameWidth = width(['NAME', ...rows.map((row) => row.name)]);
      const kindWidth = width(['KIND', ...rows.map((row) => row.kind)]);
      console.log(`${'NAME'.padEnd(nameWidth)}  ACTIVE  ${'KIND'.padEnd(kindWidth)}  URL`.trimEnd());
      for (const row of rows) {
        console.log(
          `${row.name.padEnd(nameWidth)}  ${(row.active ? '*' : ' ').padEnd('ACTIVE'.length)}  ${row.kind.padEnd(kindWidth)}  ${row.url}`.trimEnd(),
        );
      }
    });
  instances
    .command('use')
    .argument('<name>')
    .description('Select the default instance')
    .action((name: string) => {
      try {
        useInstance(name);
        console.log(`Using ${name}.`);
      } catch (err) {
        failCliOperation(program, err);
      }
    });
  instances
    .command('remove')
    .argument('<name>')
    .description('Remove a CLI profile and its local session')
    .action((name: string) => {
      try {
        removeInstance(name);
        console.log(`Removed CLI instance ${name}. Server data was not changed.`);
      } catch (err) {
        failCliOperation(program, err);
      }
    });

  const authCommand = program.command('auth').description('Manage interactive authentication');
  authCommand
    .command('recover-admin')
    .argument('<member>', 'Administrator id or email')
    .description('Reset an administrator password using local filesystem access')
    .action(async (memberRef: string) => {
      try {
        const selected = resolveInstance(selectedInstance());
        if (selected.profile.kind !== 'local') {
          throw new EmailError(
            'invalid_request',
            'Administrator recovery is only available on the local instance host.',
          );
        }
        const context = createContext();
        const target = findMember(context.db, memberRef);
        const password = await newPassword('New password', target, options.passwordPrompt ?? hiddenPrompt);
        const member = await recoverAdminPassword(context.db, memberRef, password);
        recordAdminAuditEvent(context.db, {
          operation: 'auth.recover_admin',
          outcome: 'success',
          actorMemberId: member.id,
          resourceType: 'member',
          resourceId: member.id,
        });
        console.log(`Reset ${member.name}'s password and revoked existing sessions.`);
      } catch (err) {
        failCliOperation(program, err);
      }
    });
  authCommand
    .command('sessions')
    .description('List sessions for the current member')
    .action(async () => {
      try {
        const sessions =
          await instanceClient(selectedInstance()).json<
            Array<{ id: string; deviceName: string; createdAt: number; expiresAt: number; current: boolean }>
          >('/api/v1/me/sessions');
        for (const session of sessions) {
          console.log(
            `${session.id}${session.current ? ' *' : ''}  ${session.deviceName}  created=${new Date(session.createdAt).toISOString()}  expires=${new Date(session.expiresAt).toISOString()}`,
          );
        }
      } catch (err) {
        failCliOperation(program, err);
      }
    });
  authCommand
    .command('revoke-session')
    .argument('<sessionId>')
    .description("Revoke one of the current member's sessions")
    .action(async (sessionId: string) => {
      try {
        await instanceClient(selectedInstance()).json(`/api/v1/me/sessions/${encodeURIComponent(sessionId)}`, {
          method: 'DELETE',
        });
        console.log(`Revoked ${sessionId}.`);
      } catch (err) {
        failCliOperation(program, err);
      }
    });

  program
    .command('serve')
    .description('Run the HTTP server (MCP at /mcp and REST at /api/v1)')
    .action(async () => {
      let lifecycle: RuntimeLifecycle | undefined;
      try {
        const ctx = createContext();
        lifecycle = new RuntimeLifecycle(ctx, shutdownTelemetryAndLogging);
        const app = createApp(ctx);
        const runtime = lifecycle;
        const server = serve({
          fetch: (request, env) =>
            runtime.stopping
              ? new Response('Server is shutting down.', { status: 503 })
              : runtime.request(() => app.fetch(request, env)),
          port: ctx.config.port,
        });
        lifecycle.attachServer(server);
        await waitForServerListening(server);
        if (lifecycle.stopping) return;
        ctx.logger.info('server.started', 'Fluxmail HTTP server started', {
          details: { port: ctx.config.port },
          skipConsole: true,
        });
        ctx.telemetry.capture('mcp server started', {
          ...instanceUsageProperties(ctx.db),
          product_surface: 'mcp',
          transport: 'http',
        });
        console.log(`Fluxmail listening on ${ctx.config.publicUrl}`);
        console.log(`  MCP endpoint:   ${ctx.config.publicUrl}/mcp`);
        console.log(`  REST API:       ${ctx.config.publicUrl}/api/v1`);
        console.log(`  OpenAPI:        ${ctx.config.publicUrl}/api/v1/openapi.json`);
        if (listApiKeys(ctx.db).length === 0) {
          console.log('  Note: no API keys exist yet. Run "fluxmail apikey create --name <name>" to create one.');
        }
        try {
          const accounts = ctx.registry.listAccounts();
          console.log(
            accounts.length
              ? `  Accounts:       ${accounts.map((a) => `${a.email} (${a.status})`).join(', ')}`
              : '  Accounts:       none (run "fluxmail accounts add gmail", "fluxmail accounts add outlook", or the IMAP equivalent)',
          );
        } catch {
          console.log('  Accounts:       unavailable until an existing administrator claims this instance');
        }
        console.log(`  Plan:           ${planLine(getEntitlements(ctx.db))}`);
        warnLicense(ctx.db, console.log);
        ctx.licenseController.start();
        ctx.scheduler.start();
      } catch (error) {
        finishCliOperation(program, 'error', apiErrorCode(error), error);
        await lifecycle?.close();
        throw error;
      }
    });

  program
    .command('stdio')
    .description('Run as a stdio MCP server (for Claude Desktop / Claude Code local config)')
    .option('--account <account>', 'Limit access to one mailbox; repeat as needed', collectOption, [])
    .option('--profile <profile>', `Tool profile: ${NAMED_PERMISSION_PROFILES.join(', ')}`)
    .option(
      '--allow <capability>',
      'Allow one MCP capability, or add it to --profile; repeat as needed',
      collectOption,
      [],
    )
    .action(async (opts: ScopedMcpOptions) => {
      const startupPhase = (
        phase: 'permissions' | 'instance' | 'context' | 'authentication' | 'account_scope' | 'transport' | 'ready',
      ): void => recordCliOperationProperties(program, { startup_phase: phase });
      let ctx: ReturnType<typeof createContext> | undefined;
      let server: ReturnType<typeof buildMcpServer> | undefined;
      try {
        recordCliOperationProperties(program, {
          startup_data_dir_source: process.env.FLUXMAIL_DATA_DIR ? 'environment' : 'default',
          startup_instance_selection: selectedInstance() === undefined ? 'automatic' : 'explicit',
        });
        startupPhase('permissions');
        const permissions = permissionPolicyFromOptions(opts);
        startupPhase('instance');
        const selected = resolveStdioInstance(selectedInstance());
        startupPhase('authentication');
        if (!selected.token)
          throw new CliStartupError(
            'permission_denied',
            `Log in to the local instance before starting stdio MCP. Run "fluxmail --instance ${selected.name} login".`,
            'session_missing',
          );
        startupPhase('context');
        ctx = createContext();
        startupPhase('authentication');
        const principal = authenticateBearer(ctx.db, selected.token);
        if (!principal || principal.kind !== 'session')
          throw new CliStartupError(
            'permission_denied',
            `The local CLI session has expired. Run "fluxmail --instance ${selected.name} login".`,
            'session_invalid',
          );
        startupPhase('account_scope');
        const accountIds = accountIdsFromRefs(ctx, opts.account);
        const scopedService = ctx.service.withPrincipal({ ...principal, accountIds });
        startupPhase('transport');
        server = buildMcpServer(scopedService, {
          permissions,
          maxAttachmentBytes: ctx.config.maxAttachmentBytes,
          telemetry: ctx.telemetry,
          transport: 'stdio',
          logger: ctx.logger,
        });
        installTelemetrySignalHandlers();
        installStdioShutdownHandler(process.stdin);
        await server.connect(new StdioServerTransport());
        ctx.telemetry.capture('mcp server started', {
          ...instanceUsageProperties(ctx.db),
          product_surface: 'mcp',
          transport: 'stdio',
        });
        ctx.logger.info('server.started', 'Fluxmail stdio MCP server started', {
          productSurface: 'mcp',
          details: { transport: 'stdio' },
          skipConsole: true,
        });
        // stdout belongs to the MCP protocol; log to stderr only.
        ctx.licenseController.start();
        console.error('Fluxmail MCP server running on stdio');
        if (!opts.profile && !opts.allow.length) {
          console.error(
            'No permission profile selected, so this connection is read-only. ' +
              'Add --profile or --allow to enable drafts, organizing, or sending: https://fluxmail.ai/docs/permissions',
          );
        }
        warnLicense(ctx.db);
        const pending = permissions.capabilities.includes('mail.read')
          ? scopedService.listScheduled().filter((send) => send.status === 'pending').length
          : 0;
        if (pending > 0)
          console.error(
            `Scheduled sends pending: ${pending}. Delivery requires "fluxmail serve" or "fluxmail scheduled run" using the same data directory.`,
          );
        startupPhase('ready');
      } catch (error) {
        finishCliOperation(program, 'error', apiErrorCode(error), error);
        if (ctx) {
          const context = ctx;
          await Promise.allSettled([
            Promise.resolve().then(() => context.scheduler.stop()),
            Promise.resolve().then(() => context.licenseController.stop()),
            Promise.resolve().then(() => server?.close()),
          ]);
          await context.registry.close().catch(() => {});
          try {
            (context.db as unknown as { $client: { close(): void } }).$client.close();
          } catch {}
        }
        throw error;
      }
    });

  const accounts = program.command('accounts').description('Manage connected email accounts');

  interface CliSendAsIdentity {
    email: string;
    name?: string;
    isPrimary: boolean;
    source: 'provider' | 'configured';
  }

  const sendAs = accounts.command('send-as').description('Manage sender addresses');
  sendAs
    .command('list')
    .argument('<account-id>', 'Email account ID')
    .description('List available sender addresses')
    .action(async (accountId: string) => {
      try {
        const identities = await instanceClient(selectedInstance()).json<CliSendAsIdentity[]>(
          `/api/v1/accounts/${encodeURIComponent(accountId)}/send-as`,
        );
        console.log(JSON.stringify(identities, null, 2));
      } catch (err) {
        failCliOperation(program, err);
      }
    });

  sendAs
    .command('add')
    .argument('<account-id>', 'Email account ID')
    .argument('<email>', 'Existing provider alias')
    .option('--name <name>', 'Sender display name')
    .description('Add a configured Outlook or IMAP sender address')
    .action(async (accountId: string, email: string, opts: { name?: string }) => {
      try {
        const client = instanceClient(selectedInstance());
        const existing = await client.json<CliSendAsIdentity[]>(
          `/api/v1/accounts/${encodeURIComponent(accountId)}/send-as`,
        );
        const configured = existing
          .filter((identity) => identity.source === 'configured' && !identity.isPrimary)
          .map(({ email, name }) => ({ email, ...(name ? { name } : {}) }));
        const normalized = email.trim().toLowerCase();
        const next = configured.filter((identity) => identity.email.toLowerCase() !== normalized);
        next.push({ email: email.trim(), ...(opts.name?.trim() ? { name: opts.name.trim() } : {}) });
        await client.json(`/api/v1/accounts/${encodeURIComponent(accountId)}/send-as`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ identities: next }),
        });
        console.log(`Added sender address ${email.trim()} to ${accountId}.`);
      } catch (err) {
        failCliOperation(program, err);
      }
    });

  sendAs
    .command('remove')
    .argument('<account-id>', 'Email account ID')
    .argument('<email>', 'Configured sender address')
    .description('Remove a configured Outlook or IMAP sender address')
    .action(async (accountId: string, email: string) => {
      try {
        const client = instanceClient(selectedInstance());
        const existing = await client.json<CliSendAsIdentity[]>(
          `/api/v1/accounts/${encodeURIComponent(accountId)}/send-as`,
        );
        const normalized = email.trim().toLowerCase();
        const configured = existing
          .filter(
            (identity) =>
              identity.source === 'configured' && !identity.isPrimary && identity.email.toLowerCase() !== normalized,
          )
          .map(({ email, name }) => ({ email, ...(name ? { name } : {}) }));
        await client.json(`/api/v1/accounts/${encodeURIComponent(accountId)}/send-as`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ identities: configured }),
        });
        console.log(`Removed sender address ${email.trim()} from ${accountId}.`);
      } catch (err) {
        failCliOperation(program, err);
      }
    });

  accounts
    .command('add')
    .argument('<provider>', 'Email provider: gmail, outlook, or imap')
    .option('--reauthorize <account-id>', 'Reconnect an existing account')
    .option('--local', 'Use the local browser callback for OAuth')
    .option('--hosted', 'Use FLUXMAIL_PUBLIC_URL for the OAuth callback')
    .option('--email <address>', 'Mailbox address (required for IMAP)')
    .option('--display-name <name>', 'Sender name for IMAP messages')
    .option('--imap-host <host>', 'IMAP server hostname')
    .option('--imap-port <port>', 'IMAP server port', '993')
    .option('--imap-security <mode>', 'IMAP security: tls or starttls', 'tls')
    .option('--imap-user <user>', 'IMAP username; defaults to the mailbox address')
    .option('--imap-password-env <name>', 'Read the IMAP password from this environment variable')
    .option('--smtp-host <host>', 'SMTP server hostname')
    .option('--smtp-port <port>', 'SMTP server port', '587')
    .option('--smtp-security <mode>', 'SMTP security: tls or starttls', 'starttls')
    .option('--smtp-user <user>', 'SMTP username; defaults to the IMAP username')
    .option('--smtp-password-env <name>', 'Read a separate SMTP password from this environment variable')
    .option('--sent-folder <path>', 'Sent mailbox path')
    .option('--drafts-folder <path>', 'Drafts mailbox path')
    .option('--trash-folder <path>', 'Trash mailbox path')
    .option('--archive-folder <path>', 'Archive mailbox path')
    .option('--spam-folder <path>', 'Spam mailbox path')
    .option('--no-save-sent', 'Do not append SMTP submissions to the Sent folder')
    .description('Connect a Gmail, Outlook, or IMAP account')
    .action(async (providerInput: string, opts: AddAccountOptions, command: Command) => {
      const provider = providerInput === 'microsoft' ? 'outlook' : providerInput;
      if (provider !== 'gmail' && provider !== 'outlook' && provider !== 'imap') {
        finishCliOperation(program, 'error', 'invalid_request');
        console.error(`Provider "${providerInput}" is not supported. Available: gmail, outlook, imap`);
        process.exitCode = 1;
        return;
      }
      const selected = resolveInstance(selectedInstance());
      // A remote instance reconnects an IMAP mailbox that matches the address,
      // so without --reauthorize only the server knows which one this is.
      const reauthorize =
        opts.reauthorize !== undefined
          ? true
          : selected.profile.kind === 'remote' && provider === 'imap'
            ? undefined
            : false;
      recordCliOperationProperties(
        program,
        connectionProperties({
          provider,
          reauthorize,
          stage: 'cli_validation',
          ...(provider === 'imap' ? { flow: 'imap_credentials' as const } : {}),
        }),
      );
      if (!selected.token) {
        failCliOperation(
          program,
          new EmailError('permission_denied', `Log in to instance "${selected.name}" before connecting a mailbox.`),
        );
        return;
      }
      try {
        validateAccountConnectionFlags(provider, opts);
      } catch (err) {
        failCliOperation(program, err);
        return;
      }
      let useControlPlane = selected.profile.kind === 'remote' || provider === 'imap';
      if (selected.profile.kind === 'remote' && provider !== 'imap') {
        // A remote instance always completes OAuth through its own public URL.
        recordCliOperationProperties(program, connectionProperties({ provider, reauthorize, flow: 'hosted' }));
      }
      if (selected.profile.kind === 'local' && provider !== 'imap') {
        try {
          const { config } = createContext();
          const mode = selectGmailConnectionMode(config, opts);
          recordCliOperationProperties(
            program,
            connectionProperties({
              provider,
              reauthorize,
              flow: mode === 'hosted' ? 'hosted' : 'loopback',
              oauthApp: configuredOAuthAppKind(config, provider),
            }),
          );
          // A configured public URL selects the hosted flow on its own, so report a
          // missing OAuth app here instead of after a connection grant is minted.
          if (mode === 'hosted') {
            assertHostedConnectionReady(config, provider, opts.hosted ? undefined : LOOPBACK_FLOW_REMEDY);
          }
          useControlPlane = mode === 'hosted';
        } catch (err) {
          failCliOperation(program, err);
          return;
        }
      }
      if (useControlPlane) {
        let localImapReauthorize = reauthorize ?? false;
        try {
          if (selected.profile.kind === 'remote' && opts.local) {
            throw new EmailError('invalid_request', '--local is only available for the local instance.');
          }
          let request: Record<string, unknown> = {
            provider,
            ...(opts.reauthorize ? { reauthorizeAccountId: opts.reauthorize } : {}),
          };
          if (provider === 'imap') {
            const email = opts.email?.trim();
            if (!email || !email.includes('@'))
              throw new EmailError('invalid_request', '--email must be a mailbox address.');
            if (!opts.imapHost) throw new EmailError('invalid_request', '--imap-host is required for IMAP accounts.');
            if (!opts.smtpHost) throw new EmailError('invalid_request', '--smtp-host is required for IMAP accounts.');
            if (selected.profile.kind === 'local' && !localImapReauthorize) {
              localImapReauthorize =
                (await inspectLocalRegistry((registry) =>
                  registry.listAccounts().some((account) => account.email.toLowerCase() === email.toLowerCase()),
                )) ?? false;
            }
            const imapPassword = await accountSecret(opts.imapPasswordEnv, 'IMAP password');
            const smtpPassword = opts.smtpPasswordEnv
              ? await accountSecret(opts.smtpPasswordEnv, 'SMTP password')
              : imapPassword;
            const imapUser = opts.imapUser ?? email;
            request = {
              ...request,
              email,
              ...(opts.displayName ? { displayName: opts.displayName } : {}),
              imap: {
                host: opts.imapHost,
                port: connectionPort(opts.imapPort, '--imap-port'),
                security: connectionSecurity(opts.imapSecurity, '--imap-security'),
                user: imapUser,
                password: imapPassword,
              },
              smtp: {
                host: opts.smtpHost,
                port: connectionPort(opts.smtpPort, '--smtp-port'),
                security: connectionSecurity(opts.smtpSecurity, '--smtp-security'),
                user: opts.smtpUser ?? imapUser,
                password: smtpPassword,
              },
              ...(command.getOptionValueSource('saveSent') !== 'default' ? { saveSent: opts.saveSent } : {}),
              folderOverrides: {
                ...(opts.sentFolder ? { sent: opts.sentFolder } : {}),
                ...(opts.draftsFolder ? { drafts: opts.draftsFolder } : {}),
                ...(opts.trashFolder ? { trash: opts.trashFolder } : {}),
                ...(opts.archiveFolder ? { archive: opts.archiveFolder } : {}),
                ...(opts.spamFolder ? { spam: opts.spamFolder } : {}),
              },
            };
          }
          // The server's IMAP connection check has its own 30-second limit. Give
          // its response a small margin so the CLI reports the server's result.
          const requestTimeoutMs =
            provider === 'imap' && program.getOptionValueSource('timeout') === 'default'
              ? IMAP_CONNECTION_TEST_TIMEOUT_MS + 5_000
              : undefined;
          const requestTimeoutClass =
            program.getOptionValueSource('timeout') !== 'default'
              ? 'custom'
              : requestTimeoutMs
                ? 'imap_margin'
                : 'default';
          const requestId = randomUUID();
          recordCliOperationProperties(program, {
            connection_stage: 'connection_request',
            request_timeout_class: requestTimeoutClass,
          });
          const requestStartedAt = performance.now();
          let result: {
            connectionUrl?: string;
            account?: { id: string; email: string };
            warnings?: Array<{ message: string }>;
          };
          try {
            result = await instanceClient(selected.name, true, requestTimeoutMs).json<{
              connectionUrl?: string;
              account?: { id: string; email: string };
              warnings?: Array<{ message: string }>;
            }>('/api/v1/accounts/connections', {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-request-id': requestId },
              body: JSON.stringify(request),
            });
          } catch (error) {
            const status = apiHttpStatus(error);
            recordCliOperationProperties(program, {
              connection_request_duration_ms: performance.now() - requestStartedAt,
              ...(status === undefined ? { http_status: 0 } : { http_status: status }),
            });
            if (error && typeof error === 'object' && !apiRequestId(error)) Object.assign(error, { requestId });
            throw error;
          }
          recordCliOperationProperties(program, {
            connection_request_duration_ms: performance.now() - requestStartedAt,
            ...(result.connectionUrl
              ? { connection_stage: 'oauth_prepare' }
              : result.account
                ? { connection_stage: 'complete' }
                : {}),
          });
          if (result.connectionUrl) console.log(`Open this URL in your browser:\n\n  ${result.connectionUrl}\n`);
          if (result.account) {
            if (selected.profile.kind === 'local' && provider === 'imap') {
              const inventory = await inspectLocalRegistry((registry) => accountInventoryProperties(registry));
              recordCliOperationProperties(program, {
                reauthorize: localImapReauthorize,
                ...inventory,
              });
            }
            console.log(`Connected ${result.account.email} (account id: ${result.account.id})`);
            for (const warning of result.warnings ?? []) console.log(`Warning: ${warning.message}.`);
          }
        } catch (err) {
          failCliOperation(program, err);
        }
        return;
      }
      const ctx = createContext();
      warnLicense(ctx.db);
      try {
        const principal = authenticateBearer(ctx.db, selected.token);
        if (!principal || principal.kind !== 'session') {
          throw new EmailError(
            'permission_denied',
            'The local CLI session has expired. Run "fluxmail login --instance local".',
          );
        }
        const owner = findMember(ctx.db, principal.memberId);
        const existing = opts.reauthorize ? ctx.registry.getAccount(opts.reauthorize) : undefined;
        if (existing && !canManageOwnedAccount(principal, existing)) {
          throw new EmailError('permission_denied', 'Only the mailbox owner or an administrator can reauthorize it.');
        }
        if (existing && existing.provider !== provider) {
          throw new EmailError('invalid_request', `Account ${existing.id} uses ${existing.provider}, not ${provider}.`);
        }
        if (!existing) ctx.registry.assertCanAddAccount();
        const access = { sharedWithAll: false, grantedMemberIds: [] };
        const accountIdsBeforeConnection = new Set(ctx.registry.listAccounts().map((account) => account.id));
        const auditConnection = (operation: string, accountId?: string): void => {
          try {
            recordAdminAuditEvent(ctx.db, {
              operation,
              outcome: 'success',
              actorMemberId: principal.memberId,
              actorSessionId: principal.sessionId,
              ...(accountId ? { resourceType: 'account', resourceId: accountId } : {}),
            });
          } catch {
            // Audit storage must not replace the connection result.
          }
        };

        if (provider === 'outlook') {
          const connectionMode = selectGmailConnectionMode(ctx.config, opts);
          if (connectionMode === 'hosted') {
            const { connectionUrl } = prepareHostedOutlookConnection(ctx.db, ctx.config, {
              ownerMemberId: owner.id,
              ...(existing ? { reauthorizeAccountId: existing.id } : {}),
              ...(!existing ? access : {}),
            });
            auditConnection('account.connection.prepare', existing?.id);
            console.log('\nOpen this URL in your browser to connect Outlook:\n');
            console.log(`  ${connectionUrl}\n`);
            console.log('This link expires in 10 minutes and can only be used once.');
            return;
          }

          const account = await runMicrosoftLoopbackFlow(
            ctx.config,
            (url, context) => printLoopbackInstructions('outlook', url, context, ctx.config.oauthPort),
            (result) => {
              const duplicate = ctx.registry
                .listAccounts()
                .find((candidate) => candidate.email.toLowerCase() === result.email.toLowerCase());
              if (duplicate && !canManageOwnedAccount(principal, duplicate)) {
                throw new EmailError(
                  'permission_denied',
                  'Only the mailbox owner or an administrator can reauthorize it.',
                );
              }
              if (existing && result.email.toLowerCase() !== existing.email.toLowerCase()) {
                throw new EmailError(
                  'invalid_request',
                  `Microsoft authorized ${result.email}, but account ${existing.id} belongs to ${existing.email}. ` +
                    'Try again and choose the matching Microsoft account.',
                );
              }
              return ctx.registry.addOutlookAccount(
                result.email,
                result.credentials,
                result.displayName,
                owner.id,
                existing?.id,
                access,
              );
            },
            loopbackFlowOptions(program, 'outlook'),
          );
          auditConnection('account.connection.complete', account.id);
          recordCliOperationProperties(program, {
            connection_stage: 'complete',
            reauthorize: accountIdsBeforeConnection.has(account.id),
            ...accountInventoryProperties(ctx.registry),
          });
          console.log(
            `\nConnected ${account.email} (account id: ${account.id})` +
              (account.ownerMemberId === owner.id ? ` for member ${owner.name}` : ''),
          );
          return;
        }

        const gmailConnectionMode = selectGmailConnectionMode(ctx.config, opts);
        if (gmailConnectionMode === 'hosted') {
          const { connectionUrl } = prepareHostedGmailConnection(ctx.db, ctx.config, {
            ownerMemberId: owner.id,
            ...(existing ? { reauthorizeAccountId: existing.id } : {}),
            ...(!existing ? access : {}),
          });
          auditConnection('account.connection.prepare', existing?.id);
          console.log('\nOpen this URL in your browser to connect Gmail:\n');
          console.log(`  ${connectionUrl}\n`);
          console.log('This link expires in 10 minutes and can only be used once.');
          return;
        }

        const account = await runLoopbackFlow(
          ctx.config,
          (url, context) => printLoopbackInstructions('gmail', url, context, ctx.config.oauthPort),
          (result) => {
            const duplicate = ctx.registry
              .listAccounts()
              .find((candidate) => candidate.email.toLowerCase() === result.email.toLowerCase());
            if (duplicate && !canManageOwnedAccount(principal, duplicate)) {
              throw new EmailError(
                'permission_denied',
                'Only the mailbox owner or an administrator can reauthorize it.',
              );
            }
            if (existing && result.email !== existing.email) {
              throw new EmailError(
                'invalid_request',
                `Google authorized ${result.email}, but account ${existing.id} belongs to ${existing.email}. ` +
                  'Try again and choose the matching Google account.',
              );
            }
            return ctx.registry.addGmailAccount(
              result.email,
              result.tokens,
              result.displayName,
              owner.id,
              access,
              result.oauthClient,
            );
          },
          loopbackFlowOptions(program, 'gmail'),
        );
        auditConnection('account.connection.complete', account.id);
        recordCliOperationProperties(program, {
          connection_stage: 'complete',
          reauthorize: accountIdsBeforeConnection.has(account.id),
          ...accountInventoryProperties(ctx.registry),
        });
        console.log(
          `\nConnected ${account.email} (account id: ${account.id})` +
            (account.ownerMemberId === owner.id ? ` for member ${owner.name}` : ''),
        );
        if (account.ownerMemberId !== owner.id) {
          // The mailbox was already connected; re-auth keeps its existing owner.
          console.log(
            `${account.email} was already connected, so its ownership is unchanged. ` +
              `To assign it to ${owner.name}, run "fluxmail accounts assign ${account.id} --owner ${owner.id}".`,
          );
        }
      } catch (err) {
        failCliOperation(program, err, '\nError: ');
      }
    });

  accounts
    .command('configure')
    .argument('<accountId>')
    .option('--sent-folder <path>', 'Sent path, or auto to clear the override')
    .option('--drafts-folder <path>', 'Drafts path, or auto to clear the override')
    .option('--trash-folder <path>', 'Trash path, or auto to clear the override')
    .option('--archive-folder <path>', 'Archive path, or auto to clear the override')
    .option('--spam-folder <path>', 'Spam path, or auto to clear the override')
    .description('Set special folder paths for an IMAP account')
    .action(
      async (
        accountId: string,
        opts: {
          sentFolder?: string;
          draftsFolder?: string;
          trashFolder?: string;
          archiveFolder?: string;
          spamFolder?: string;
        },
      ) => {
        try {
          const changes = [
            ['sent', opts.sentFolder],
            ['drafts', opts.draftsFolder],
            ['trash', opts.trashFolder],
            ['archive', opts.archiveFolder],
            ['spam', opts.spamFolder],
          ] as const;
          if (!changes.some(([, value]) => value !== undefined)) {
            throw new EmailError('invalid_request', 'Pass at least one folder option.');
          }
          const patch: Record<string, string | null> = {};
          for (const [role, value] of changes) {
            if (value !== undefined) patch[role] = value === 'auto' ? null : value;
          }
          const result = await instanceClient(selectedInstance()).json<{
            warnings: Array<{ message: string }>;
          }>(`/api/v1/accounts/${encodeURIComponent(accountId)}/imap/folders`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          });
          console.log(`Updated folder settings for ${accountId}.`);
          for (const warning of result.warnings) console.log(`Warning: ${warning.message}.`);
        } catch (err) {
          failCliOperation(program, err);
        }
      },
    );

  accounts
    .command('list')
    .description('List connected accounts')
    .action(async () => {
      try {
        const all = await instanceClient(selectedInstance()).json<
          Array<{
            id: string;
            provider: string;
            email: string;
            status: string;
            ownerMemberId: string;
            sharedWithAll: boolean;
            grantedMemberIds: string[];
          }>
        >('/api/v1/accounts');
        printOutput({ data: all }, selectedFormat());
      } catch (err) {
        failCliOperation(program, err);
      }
    });

  accounts
    .command('remove')
    .argument('<accountId>')
    .description('Disconnect an account and delete its stored tokens')
    .action(async (accountId: string) => {
      try {
        const selected = resolveInstance(selectedInstance());
        const provider =
          selected.profile.kind === 'local'
            ? await inspectLocalRegistry((registry) => registry.getAccount(accountId).provider)
            : undefined;
        await instanceClient(selected.name).json(`/api/v1/accounts/${encodeURIComponent(accountId)}/connection`, {
          method: 'DELETE',
        });
        if (selected.profile.kind === 'local') {
          const inventory = await inspectLocalRegistry((registry) => accountInventoryProperties(registry));
          recordCliOperationProperties(program, {
            ...(provider ? { provider } : {}),
            ...inventory,
          });
        }
        console.log(`Removed ${accountId}`);
      } catch (err) {
        failCliOperation(program, err);
      }
    });

  accounts
    .command('assign')
    .argument('<accountId>')
    .requiredOption('--owner <member>', 'Member id or email to own the mailbox')
    .description('Change mailbox ownership')
    .action(async (accountId: string, opts: { owner: string }) => {
      try {
        const account = await instanceClient(selectedInstance()).json<{ email: string; ownerMemberId: string }>(
          `/api/v1/admin/accounts/${encodeURIComponent(accountId)}`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ownerMemberId: opts.owner }),
          },
        );
        console.log(`${account.email} is now owned by ${account.ownerMemberId}.`);
      } catch (err) {
        failCliOperation(program, err);
      }
    });

  accounts
    .command('access')
    .argument('<accountId>')
    .option('--owner-only', 'Only the owner can access the mailbox')
    .option('--shared', 'Share the mailbox with every member')
    .option('--share-with <member>', 'Replace selected access with this member; repeat as needed', collectOption, [])
    .description('Set who can access a mailbox')
    .action(async (accountId: string, opts: { ownerOnly?: boolean; shared?: boolean; shareWith: string[] }) => {
      try {
        const choices =
          Number(Boolean(opts.ownerOnly)) + Number(Boolean(opts.shared)) + Number(opts.shareWith.length > 0);
        if (choices !== 1) {
          throw new EmailError(
            'invalid_request',
            'Pass exactly one of --owner-only, --shared, or one or more --share-with options.',
          );
        }
        const account = await instanceClient(selectedInstance()).json<{
          email: string;
          sharedWithAll: boolean;
          grantedMemberIds: string[];
        }>(`/api/v1/admin/accounts/${encodeURIComponent(accountId)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sharedWithAll: opts.shared === true, grantedMemberIds: opts.shareWith }),
        });
        console.log(
          `Updated access for ${account.email}: ${account.sharedWithAll ? 'all members' : `${account.grantedMemberIds.length} explicit grant(s)`}.`,
        );
      } catch (err) {
        failCliOperation(program, err);
      }
    });

  const membersCmd = program.command('members').description('Manage members (people using this instance)');

  membersCmd
    .command('add')
    .requiredOption('--name <name>', 'Member name')
    .requiredOption('--email <email>', 'Member login email')
    .option('--role <role>', 'Member role: admin or member')
    .description("Add a member (subject to your plan's member limit)")
    .action(async (opts: { name: string; email: string; role?: string }) => {
      try {
        if (opts.role && opts.role !== 'admin' && opts.role !== 'member') {
          throw new EmailError('invalid_request', '--role must be "admin" or "member".');
        }
        const member = await instanceClient(selectedInstance()).json<{
          id: string;
          name: string;
          role: string;
          invitation: { token: string; expiresAt: number };
        }>('/api/v1/admin/members', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: opts.name, email: opts.email, role: opts.role ?? 'member' }),
        });
        console.log(`Added ${member.name} (id: ${member.id}, role: ${member.role}).`);
        console.log(`Enrollment code (shown once): ${member.invitation.token}`);
        console.log(`Expires: ${new Date(member.invitation.expiresAt).toISOString()}`);
      } catch (err) {
        failCliOperation(program, err);
      }
    });

  membersCmd
    .command('list')
    .description('List members with their mailbox and API key counts')
    .action(async () => {
      try {
        const all = await instanceClient(selectedInstance()).json<
          Array<{
            id: string;
            name: string;
            role: string;
            status: string;
            email: string | null;
            accountCount: number;
            apiKeyCount: number;
          }>
        >('/api/v1/admin/members');
        if (!all.length) {
          console.log('No members. Run "fluxmail members add --name <name>".');
          return;
        }
        for (const m of all) {
          console.log(
            `${m.id}  ${m.name}  role=${m.role}  status=${m.status}  email=${m.email ?? '-'}  mailboxes=${m.accountCount}  keys=${m.apiKeyCount}`,
          );
        }
      } catch (err) {
        failCliOperation(program, err);
      }
    });

  membersCmd
    .command('remove')
    .argument('<memberId>')
    .description('Remove a member after reassigning or removing their mailboxes')
    .action(async (memberId: string) => {
      try {
        await instanceClient(selectedInstance()).json(`/api/v1/admin/members/${encodeURIComponent(memberId)}`, {
          method: 'DELETE',
        });
        console.log(`Removed ${memberId}.`);
      } catch (err) {
        failCliOperation(program, err);
      }
    });

  membersCmd
    .command('role')
    .argument('<member>', 'Member id or email')
    .argument('<role>', 'admin or member')
    .description('Change a member role')
    .action(async (memberRef: string, role: string) => {
      try {
        if (role !== 'admin' && role !== 'member') {
          throw new EmailError('invalid_request', 'Role must be "admin" or "member".');
        }
        const member = await instanceClient(selectedInstance()).json<{ name: string; role: string }>(
          `/api/v1/admin/members/${encodeURIComponent(memberRef)}`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ role }),
          },
        );
        console.log(`${member.name} now has the ${member.role} role.`);
      } catch (err) {
        failCliOperation(program, err);
      }
    });

  membersCmd
    .command('status')
    .argument('<member>', 'Member id or email')
    .argument('<status>', 'active or suspended')
    .description('Activate or suspend a member')
    .action(async (memberRef: string, status: string) => {
      try {
        if (status !== 'active' && status !== 'suspended') {
          throw new EmailError('invalid_request', 'Status must be "active" or "suspended".');
        }
        const member = await instanceClient(selectedInstance()).json<{ name: string; status: string }>(
          `/api/v1/admin/members/${encodeURIComponent(memberRef)}`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ status }),
          },
        );
        console.log(`${member.name} is now ${member.status}.`);
      } catch (err) {
        failCliOperation(program, err);
      }
    });

  for (const [commandName, endpoint, label] of [
    ['invite', 'invitation', 'Enrollment code'],
    ['password-reset', 'password-reset', 'Password reset code'],
  ] as const) {
    membersCmd
      .command(commandName)
      .argument('<member>', 'Member id or email')
      .description(commandName === 'invite' ? 'Issue a new enrollment code' : 'Issue a password reset code')
      .action(async (memberRef: string) => {
        try {
          const token = await instanceClient(selectedInstance()).json<{ token: string; expiresAt: number }>(
            `/api/v1/admin/members/${encodeURIComponent(memberRef)}/${endpoint}`,
            { method: 'POST' },
          );
          console.log(`${label} (shown once): ${token.token}`);
          console.log(`Expires: ${new Date(token.expiresAt).toISOString()}`);
        } catch (err) {
          failCliOperation(program, err);
        }
      });
  }

  membersCmd
    .command('sessions')
    .argument('<member>', 'Member id or email')
    .description('List sessions for a member')
    .action(async (memberRef: string) => {
      try {
        const sessions = await instanceClient(selectedInstance()).json<
          Array<{ id: string; deviceName: string; expiresAt: number }>
        >(`/api/v1/admin/members/${encodeURIComponent(memberRef)}/sessions`);
        for (const session of sessions) {
          console.log(`${session.id}  ${session.deviceName}  expires=${new Date(session.expiresAt).toISOString()}`);
        }
      } catch (err) {
        failCliOperation(program, err);
      }
    });

  membersCmd
    .command('revoke-session')
    .argument('<member>', 'Member id or email')
    .argument('<sessionId>')
    .description('Revoke a member session')
    .action(async (memberRef: string, sessionId: string) => {
      try {
        await instanceClient(selectedInstance()).json(
          `/api/v1/admin/members/${encodeURIComponent(memberRef)}/sessions/${encodeURIComponent(sessionId)}`,
          { method: 'DELETE' },
        );
        console.log(`Revoked ${sessionId}.`);
      } catch (err) {
        failCliOperation(program, err);
      }
    });

  const apikey = program.command('apikey').description('Manage API keys for the HTTP MCP and REST APIs');

  apikey
    .command('capabilities')
    .description('List capabilities for API key permission policies')
    .action(() => {
      for (const capability of [...MCP_CAPABILITIES, ...ADMIN_CAPABILITIES]) console.log(capability);
    });

  apikey
    .command('create')
    .requiredOption('--name <name>', 'Human-readable key name')
    .option('--member <member>', 'Admin only: issue the key to another member')
    .option('--account <account>', 'Limit the key to one mailbox; repeat as needed', collectOption, [])
    .option('--profile <profile>', `Tool profile: ${NAMED_PERMISSION_PROFILES.join(', ')}`)
    .option(
      '--allow <capability>',
      'Allow one capability in a custom policy, or add it to --profile; repeat as needed',
      collectOption,
      [],
    )
    .option('--admin <capability>', 'Add one admin capability to a named profile; repeat as needed', collectOption, [])
    .description('Create an API key (shown once)')
    .action(async (opts: { name: string; member?: string; account: string[] } & PermissionOptions) => {
      try {
        const permissions = permissionPolicyFromOptions(opts);
        const body = {
          name: opts.name,
          ...(opts.member ? { member: opts.member } : {}),
          accounts: opts.account.length ? opts.account : null,
          ...(permissions.profile === 'custom'
            ? { customCapabilities: permissions.capabilities }
            : {
                permissionProfile: permissions.profile,
                supplementalCapabilities: permissions.supplementalCapabilities,
              }),
        };
        const created = await instanceClient(selectedInstance()).json<{
          id: string;
          name: string;
          permissionProfile: string;
          key: string;
        }>(opts.member ? '/api/v1/admin/api-keys' : '/api/v1/me/api-keys', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            opts.member
              ? body
              : {
                  name: body.name,
                  accountIds: body.accounts,
                  ...(permissions.profile === 'custom'
                    ? { capabilities: permissions.capabilities }
                    : {
                        permissionProfile: permissions.profile,
                        supplementalCapabilities: permissions.supplementalCapabilities,
                      }),
                },
          ),
        });
        console.log(`Created API key "${created.name}" (id: ${created.id}, profile: ${created.permissionProfile}).\n`);
        console.log(`  ${created.key}\n`);
        console.log('Store it now; it cannot be shown again.');
      } catch (err) {
        failCliOperation(program, err);
      }
    });

  apikey
    .command('list')
    .description('List API keys')
    .action(async () => {
      try {
        const client = instanceClient(selectedInstance());
        const me = await client.json<{ role: string }>('/api/v1/me');
        const keys = await client.json<ApiKeyInfo[]>(
          me.role === 'admin' ? '/api/v1/admin/api-keys' : '/api/v1/me/api-keys',
        );
        if (!keys.length) {
          console.log('No API keys. Run "fluxmail apikey create --name <name>".');
          return;
        }
        for (const k of keys) {
          const lastUsed = k.lastUsedAt ? new Date(k.lastUsedAt).toISOString() : 'never';
          const accountScope = k.accountIds === null ? 'all granted' : k.accountIds.join(',') || 'none';
          console.log(
            `${k.id}  ${k.name}  member=${k.memberId}  accounts=${accountScope}  profile=${k.permissionProfile}` +
              (k.permissionProfile === 'custom' ? `  allows=${k.capabilities.join(',')}` : '') +
              (k.supplementalCapabilities.length ? `  admin=${k.supplementalCapabilities.join(',')}` : '') +
              `  created=${new Date(k.createdAt).toISOString()}  lastUsed=${lastUsed}`,
          );
        }
      } catch (err) {
        failCliOperation(program, err);
      }
    });

  apikey
    .command('accounts')
    .argument('<keyId>')
    .option('--account <account>', 'Replace the allowlist with this mailbox; repeat as needed', collectOption, [])
    .option('--all-accounts', 'Clear the allowlist')
    .description('Replace or clear an API key mailbox allowlist')
    .action(async (keyId: string, opts: { account: string[]; allAccounts?: boolean }) => {
      try {
        if (Boolean(opts.allAccounts) === Boolean(opts.account.length)) {
          throw new EmailError('invalid_request', 'Pass --all-accounts or at least one --account.');
        }
        const accountIds = opts.allAccounts ? null : opts.account;
        await instanceClient(selectedInstance()).json(`/api/v1/admin/api-keys/${encodeURIComponent(keyId)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ accounts: accountIds }),
        });
        console.log(
          accountIds === null
            ? `Cleared the mailbox allowlist for ${keyId}.`
            : `Updated ${keyId} to ${accountIds.length} mailbox(es).`,
        );
      } catch (err) {
        failCliOperation(program, err);
      }
    });

  apikey
    .command('permissions')
    .argument('<keyId>')
    .option('--profile <profile>', `Tool profile: ${NAMED_PERMISSION_PROFILES.join(', ')}`)
    .option(
      '--allow <capability>',
      'Allow one capability in a custom policy, or add it to --profile; repeat as needed',
      collectOption,
      [],
    )
    .option('--admin <capability>', 'Add one admin capability to a named profile; repeat as needed', collectOption, [])
    .description('Change the permissions for an API key')
    .action(async (keyId: string, opts: PermissionOptions) => {
      try {
        const client = instanceClient(selectedInstance());
        const existing = (await client.json<ApiKeyInfo[]>('/api/v1/admin/api-keys')).find((key) => key.id === keyId);
        if (!existing) {
          console.error(`No key with id ${keyId}`);
          process.exitCode = 1;
          return;
        }
        const permissions = permissionPolicyForUpdate(opts, existing);
        await client.json(`/api/v1/admin/api-keys/${encodeURIComponent(keyId)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            permissions.profile === 'custom'
              ? { customCapabilities: permissions.capabilities }
              : {
                  permissionProfile: permissions.profile,
                  supplementalCapabilities: permissions.supplementalCapabilities,
                },
          ),
        });
        console.log(`Updated ${keyId} to profile ${permissions.profile}`);
      } catch (err) {
        failCliOperation(program, err);
      }
    });

  apikey
    .command('revoke')
    .argument('<keyId>')
    .description('Revoke an API key')
    .action(async (keyId: string) => {
      try {
        const client = instanceClient(selectedInstance());
        const me = await client.json<{ role: string }>('/api/v1/me');
        const path =
          me.role === 'admin'
            ? `/api/v1/admin/api-keys/${encodeURIComponent(keyId)}`
            : `/api/v1/me/api-keys/${encodeURIComponent(keyId)}`;
        await client.json(path, { method: 'DELETE' });
        console.log(`Revoked ${keyId}`);
      } catch (err) {
        failCliOperation(program, err);
      }
    });

  const license = program.command('license').description('Manage the paid-tier license');

  license
    .command('activate')
    .argument('[key]', 'Deprecated: license key shown once at purchase')
    .option('--key-file <path>', 'Read the license key from a file, or use - for stdin')
    .description('Store a license key and validate it with the license server')
    .action(async (deprecatedKey: string | undefined, options: { keyFile?: string }) => {
      if (deprecatedKey && options.keyFile) {
        console.error('Error: The deprecated positional key cannot be combined with --key-file.');
        process.exitCode = 1;
        return;
      }
      if (deprecatedKey) {
        console.error('Warning: Passing a license key as an argument is deprecated. Use --key-file or hidden input.');
      }
      const key = deprecatedKey ?? (await secretInput(options.keyFile, 'License key'));
      if (!LICENSE_KEY_PATTERN.test(key)) {
        console.error(
          'That does not look like a Fluxmail license key (expected "fluxmail_lic_" followed by 40 hex characters).',
        );
        process.exitCode = 1;
        return;
      }
      try {
        const result = await instanceClient(selectedInstance()).json<{
          outcome: 'activated' | 'saved_for_retry';
          lease?: { plan: string; maxAccounts: number; maxMembers: number; expiresAt: string };
        }>('/api/v1/admin/license/activate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ licenseKey: key }),
        });
        if (result.lease) {
          console.log(
            `License activated: ${result.lease.plan} plan, up to ${result.lease.maxAccounts} mailboxes and ` +
              `${result.lease.maxMembers} member${result.lease.maxMembers === 1 ? '' : 's'}.`,
          );
          console.log(
            `The lease is valid until ${result.lease.expiresAt} and renews automatically while the server runs.`,
          );
        } else {
          console.log(
            'The license key was saved. Validation will retry when the instance can reach the license server.',
          );
        }
      } catch (err) {
        failCliOperation(program, err);
      }
    });

  license
    .command('status')
    .description('Show the configured license and cached lease')
    .action(async () => {
      try {
        const status = await instanceClient(selectedInstance()).json<{
          configured: boolean;
          source: 'environment' | 'environment-file' | 'stored' | null;
          entitlements: Entitlements;
          usage: { accounts: number; members: number; overQuota: boolean };
          lastValidatedAt: string | null;
          warning: string | null;
        }>('/api/v1/admin/license');
        console.log(
          status.configured
            ? `License configured from ${status.source}.`
            : 'No license key configured. Run "fluxmail license activate" after purchasing one.',
        );
        console.log(`Current plan: ${planLine(status.entitlements)}`);
        console.log(
          `Usage: ${status.usage.accounts} mailbox(es), ${status.usage.members} member(s)` +
            (status.usage.overQuota ? ' (over plan limits)' : ''),
        );
        if (status.lastValidatedAt) console.log(`Last validated: ${status.lastValidatedAt}`);
        if (status.warning) console.log(`Warning: ${status.warning}`);
      } catch (err) {
        failCliOperation(program, err);
      }
    });

  license
    .command('deactivate')
    .description('Release the license from this instance and remove the stored key and cached lease')
    .action(async () => {
      try {
        const result = await instanceClient(selectedInstance()).json<{
          released: boolean;
          removedStoredKey: boolean;
        }>('/api/v1/admin/license', { method: 'DELETE' });
        console.log(
          result.released
            ? 'Released the license from this instance.'
            : 'The local license was removed. The remote binding, if any, will expire automatically.',
        );
        console.log('This instance is back to Personal plan limits.');
      } catch (err) {
        failCliOperation(program, err);
      }
    });

  const configCmd = program.command('config').description('Inspect and initialize deployment configuration');

  configCmd
    .command('init')
    .description('Create config.toml in the Fluxmail data directory')
    .action(() => {
      try {
        const dataDir = resolveDataDir();
        const file = configTomlPath(dataDir);
        writeDeploymentConfig(file, deploymentToml(), { exclusive: true });
        console.log(`Created ${file}`);
      } catch (err) {
        failCliOperation(program, err);
      }
    });

  configCmd
    .command('show')
    .description('Show effective configuration, sources, paths, and restart requirements')
    .action(() => {
      const deployment = resolveStoreLocation().deployment!;
      const compatibility = inspectStoreCompatibility(deployment.dbPath, deployment.dataDir);
      const canReadInstanceSettings =
        compatibility.storeFormat >= MIN_SUPPORTED_STORE_FORMAT &&
        compatibility.storeFormat <= compatibility.maximumSupportedFormat;
      const db =
        canReadInstanceSettings && deployment.dbPath !== ':memory:'
          ? openReadonlyDb(deployment.dbPath)
          : openDb(':memory:', { backupBeforeMigration: false });
      try {
        const configuration = createConfigurationService(deployment, db);
        const config = configuration.config;
        console.log(`Data directory: ${deployment.dataDir} [${deployment.sources.dataDir}]`);
        console.log(
          `Configuration file: ${deployment.configFile}${existsSync(deployment.configFile) ? '' : ' (not created)'}`,
        );
        console.log(`Database: ${deployment.dbPath} [${deployment.sources.dbPath}] restart required`);
        console.log(`Server port: ${deployment.port} [${deployment.sources.port}] restart required`);
        console.log(`Public URL: ${deployment.publicUrl} [${deployment.sources.publicUrl}] restart required`);
        console.log(`Trust proxy: ${deployment.trustProxy} [${deployment.sources.trustProxy}] restart required`);
        console.log(`Local OAuth host: ${deployment.oauthHost} [${deployment.sources.oauthHost}] restart required`);
        console.log(`Local OAuth port: ${deployment.oauthPort} [${deployment.sources.oauthPort}] restart required`);
        console.log(
          `Maximum attachment: ${deployment.maxAttachmentBytes / (1024 * 1024)} MB [${deployment.sources.maxAttachmentBytes}] restart required`,
        );
        console.log(
          `Encryption key: ${deployment.encryptionKey.length === 32 ? 'configured' : 'not configured'} [${deployment.sources.encryptionKey}]`,
        );
        const oauth = configuration.oauthStatus();
        console.log(`Google OAuth: configured [${oauth.google.source}]`);
        console.log(
          `Outlook OAuth: ${oauth.outlook.clientId ? 'configured' : 'not configured'} [${oauth.outlook.source ?? 'none'}]`,
        );
        console.log(
          `License: ${config.licenseKey ? 'configured' : 'not configured'} [${configuration.licenseSource() ?? 'none'}]`,
        );
      } finally {
        (db as unknown as { $client: { close(): void } }).$client.close();
      }
    });

  configCmd
    .command('migrate')
    .requiredOption('--from <env-file>', 'Read recognized settings from this env file')
    .option('--dry-run', 'Show recognized setting names without changing Fluxmail')
    .description('Import settings from an env file without deleting it')
    .action((options: { from: string; dryRun?: boolean }) => {
      const source = path.resolve(options.from);
      if (options.dryRun) {
        const recognized = recognizedMigrationSettings(parseEnvContent(readFileSync(source, 'utf8')));
        console.log(recognized.length ? recognized.join('\n') : 'No recognized settings found.');
        return;
      }
      const result = migrateConfigurationFile(source);
      console.log(
        `Imported ${result.recognized.length} recognized setting${result.recognized.length === 1 ? '' : 's'} from ${result.source}.`,
      );
      console.log('Restart Fluxmail to apply deployment configuration changes.');
    });

  const oauth = program.command('oauth').description('Manage OAuth applications');

  oauth
    .command('status')
    .description('Show OAuth application status without secrets')
    .action(async () => {
      const status = await instanceClient(selectedInstance()).json('/api/v1/admin/oauth-apps');
      console.log(JSON.stringify(status, null, 2));
    });

  const oauthConfigure = oauth.command('configure').description('Configure an OAuth application');
  oauthConfigure
    .command('google')
    .requiredOption('--client-id <id>', 'Google OAuth client ID')
    .option('--client-secret-file <path>', 'Read the client secret from a file, or use - for stdin')
    .description('Configure a custom Google OAuth application')
    .action(async (options: { clientId: string; clientSecretFile?: string }) => {
      const clientSecret = await secretInput(options.clientSecretFile, 'Google client secret');
      await instanceClient(selectedInstance()).json('/api/v1/admin/oauth-apps/google', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: options.clientId, clientSecret }),
      });
      console.log('Google OAuth application configured.');
    });

  oauthConfigure
    .command('outlook')
    .requiredOption('--client-id <id>', 'Microsoft OAuth client ID')
    .option('--tenant-id <tenant>', 'Microsoft tenant ID', 'common')
    .option('--public-client', 'Configure a public client without a secret')
    .option('--client-secret-file <path>', 'Read the client secret from a file, or use - for stdin')
    .description('Configure a custom Microsoft OAuth application')
    .action(
      async (options: { clientId: string; tenantId: string; publicClient?: boolean; clientSecretFile?: string }) => {
        if (options.publicClient && options.clientSecretFile) {
          throw new EmailError('invalid_request', '--public-client cannot be combined with --client-secret-file.');
        }
        const clientSecret = options.publicClient
          ? undefined
          : await secretInput(options.clientSecretFile, 'Microsoft client secret');
        await instanceClient(selectedInstance()).json('/api/v1/admin/oauth-apps/outlook', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            clientId: options.clientId,
            tenantId: options.tenantId,
            publicClient: Boolean(options.publicClient),
            ...(clientSecret ? { clientSecret } : {}),
          }),
        });
        console.log('Microsoft OAuth application configured.');
      },
    );

  oauth
    .command('reset')
    .argument('<provider>', 'google or outlook')
    .description('Remove a stored OAuth application')
    .action(async (provider: string) => {
      if (provider !== 'google' && provider !== 'outlook') {
        throw new EmailError('invalid_request', 'Provider must be google or outlook.');
      }
      await instanceClient(selectedInstance()).json(`/api/v1/admin/oauth-apps/${provider}`, { method: 'DELETE' });
      console.log(`${provider === 'google' ? 'Google' : 'Microsoft'} OAuth application reset.`);
    });

  program
    .command('logs')
    .description('Show recent local log entries')
    .option('--tail <count>', 'Number of entries to show, from 1 through 1000', '100')
    .option('--level <level>', 'Minimum level: info, warn, or error', 'info')
    .option('--json', 'Print each entry as JSON')
    .action((opts: { tail: string; level: string; json?: boolean }) => {
      try {
        const tail = Number(opts.tail);
        if (!Number.isInteger(tail) || tail < 1 || tail > 1000) {
          throw new EmailError('invalid_request', '--tail must be an integer from 1 through 1000.');
        }
        if (!['info', 'warn', 'error'].includes(opts.level)) {
          throw new EmailError('invalid_request', '--level must be info, warn, or error.');
        }
        const result = readLocalLogs(resolveDataDir(), {
          tail,
          minimumLevel: opts.level as Exclude<LogLevel, 'off'>,
        });
        for (const entry of result.entries) {
          if (opts.json) {
            console.log(entry.raw);
            continue;
          }
          const singleLine = escapeLogTextForConsole;
          const code = entry.record.error?.code ? ` [${singleLine(entry.record.error.code)}]` : '';
          console.log(
            `${singleLine(entry.record.timestamp)} ${entry.record.level.toUpperCase()} ${singleLine(entry.record.event)}${code}: ${singleLine(entry.record.message)}`,
          );
        }
        if (result.malformedLines > 0) {
          console.error(
            `Warning: skipped ${result.malformedLines} malformed local log line${result.malformedLines === 1 ? '' : 's'}.`,
          );
        }
      } catch (error) {
        const code = isEmailError(error) ? error.code : 'internal';
        finishCliOperation(program, 'error', code, error);
        console.error(`Error [${code}]: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });

  const telemetryCmd = program.command('telemetry').description('Manage anonymous usage telemetry');

  telemetryCmd
    .command('disable')
    .description('Stop sending anonymous usage telemetry')
    .action(() => {
      const dataDir = resolveDataDir();
      setTelemetryEnabled(dataDir, false);
      console.log('Telemetry disabled.');
    });

  telemetryCmd
    .command('enable')
    .description('Allow anonymous usage telemetry')
    .action(() => {
      const dataDir = resolveDataDir();
      setTelemetryEnabled(dataDir, true);
      console.log('Telemetry enabled. FLUXMAIL_TELEMETRY=0 or DO_NOT_TRACK=1 can still turn it off.');
    });

  telemetryCmd
    .command('status')
    .description('Show whether anonymous usage telemetry is enabled')
    .action(() => {
      const dataDir = resolveDataDir();
      console.log(`Telemetry is ${isTelemetryEnabled(dataDir) ? 'enabled' : 'disabled'}.`);
    });

  registerMailCommands(program, {
    selectedInstance,
    selectedAccount,
    selectedFormat,
    reportError: (error, code) => {
      finishCliOperation(program, 'error', code, error);
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        selectedFormat() === 'table'
          ? `Error [${code}]: ${message}`
          : JSON.stringify({
              error: { code, message, ...(apiRequestId(error) ? { requestId: apiRequestId(error) } : {}) },
            }),
      );
      process.exitCode = cliExitCode(code);
    },
    reportPartialFailure: (code) => {
      finishCliOperation(program, 'error', code);
      process.exitCode = cliExitCode(code);
    },
  });

  program.commands
    .find((command) => command.name() === 'scheduled')!
    .command('run')
    .description('Run scheduled delivery for this local instance without HTTP or MCP')
    .action(async () => {
      let lifecycle: RuntimeLifecycle | undefined;
      try {
        if (selectedAccount() !== undefined) {
          throw new EmailError('invalid_request', 'scheduled run processes the whole instance; omit --mail-account.');
        }
        const name = selectedInstance();
        if (name !== undefined) {
          const profile = loadInstanceConfig().instances[name];
          if (!profile) throw new EmailError('not_found', `No CLI instance named "${name}".`);
          if (profile.kind !== 'local') {
            throw new EmailError(
              'invalid_request',
              'scheduled run requires a local instance. Run it on the host that stores the schedules.',
            );
          }
        }
        const ctx = createContext();
        lifecycle = new RuntimeLifecycle(ctx, shutdownTelemetryAndLogging);
        ctx.licenseController.start();
        ctx.scheduler.start();
        console.log('Fluxmail scheduled delivery running. Press Ctrl-C to stop.');
      } catch (error) {
        finishCliOperation(program, 'error', apiErrorCode(error), error);
        await lifecycle?.close();
        throw error;
      }
    });

  program
    .command('status')
    .description('Show mailbox and provider status for the selected instance')
    .action(async () => {
      try {
        const status = await instanceClient(selectedInstance()).json('/api/v1/status');
        printOutput({ data: status }, selectedFormat());
      } catch (err) {
        failCliOperation(program, err);
      }
    });

  return program;
}

export async function runCli(argv: readonly string[] = process.argv): Promise<void> {
  const program = createCliProgram({ updateNotifierFactory: createCliUpdateNotifier });
  try {
    await program.parseAsync([...argv]);
  } catch (err) {
    failCliOperation(program, err);
    await Promise.all([shutdownTelemetry(), shutdownLogging()]);
  }
}

function isEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  }
}

if (isEntrypoint()) void runCli();
