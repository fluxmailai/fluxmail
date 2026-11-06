import {
  createConfigurationService,
  ensureDeploymentEncryptionKey,
  resolveStoreLocation,
  type ConfigurationService,
  type FluxmailConfig,
} from './config.js';
import { IncompatibleStoreError, inspectStoreCompatibility, openDb, type FluxmailDb } from './storage/db.js';
import { AccountRegistry } from './accounts/registry.js';
import { EmailService } from './service/emailService.js';
import { SendScheduler } from './scheduler/sendScheduler.js';
import { getTelemetry, type Telemetry } from './telemetry.js';
import { LicenseController } from './licensing/refresher.js';
import { getLogger, type Logger, type ProcessMode } from './logging.js';
import { ServerUpdateCheck } from './updateNotifier.js';

export interface AppContext {
  config: FluxmailConfig;
  configuration: ConfigurationService;
  db: FluxmailDb;
  registry: AccountRegistry;
  service: EmailService;
  telemetry: Telemetry;
  logger: Logger;
  /** Inert until start(); only the long-lived serve/scheduled run commands start it. */
  scheduler: SendScheduler;
  licenseController: LicenseController;
  /** Inert until start(); only the serve command starts it. */
  updateCheck: ServerUpdateCheck;
}

export function createContext(options: { logger?: Logger; processMode?: ProcessMode } = {}): AppContext {
  const storeLocation = resolveStoreLocation();
  const compatibility = inspectStoreCompatibility(storeLocation.dbPath, storeLocation.dataDir);
  if (!compatibility.compatible) throw new IncompatibleStoreError(compatibility);
  const deployment = ensureDeploymentEncryptionKey(storeLocation.deployment!);
  const logger =
    options.logger ??
    getLogger(deployment.dataDir, options.processMode ?? 'library', {
      level: deployment.logLevel,
      destination: deployment.logDestination,
    });
  const db = openDb(deployment.dbPath, { dataDir: deployment.dataDir });
  try {
    const configuration: ConfigurationService = createConfigurationService(deployment, db);
    const config = configuration.config;
    const registry = new AccountRegistry(db, config);
    const service = new EmailService(
      registry,
      db,
      undefined,
      config.encryptionKey,
      config.maxAttachmentBytes,
      config.timeZone,
      logger,
    );
    const scheduler = new SendScheduler(db, service, logger);
    const telemetry = getTelemetry(config.dataDir, deployment.environment);
    const licenseController = new LicenseController({
      db,
      config,
      configuration,
      logger,
      onRefreshed: () => scheduler.licenseRefreshed(),
    });
    service.onScheduleChanged = () => scheduler.wake();
    const updateCheck = new ServerUpdateCheck({ logger });
    return {
      config,
      configuration,
      db,
      registry,
      service,
      scheduler,
      telemetry,
      logger,
      licenseController,
      updateCheck,
    };
  } catch (error) {
    (db as unknown as { $client: { close(): void } }).$client.close();
    throw error;
  }
}

/**
 * Stops the context's background work and waits for it and for `drains`, such as a server that is closing,
 * before it closes provider connections and the database, even if a drain fails. Returns every failure
 * instead of throwing, so the caller decides how to report them. `proceed` lets a caller stop between steps.
 */
export async function closeAppContext(
  context: AppContext,
  drains: Promise<unknown>[] = [],
  proceed: () => boolean = () => true,
): Promise<unknown[]> {
  // Each stop disables its timers synchronously before waiting for active work.
  const stopped = [context.scheduler.stop(), context.licenseController.stop()];
  context.updateCheck.stop();
  const results = await Promise.allSettled([...stopped, ...drains]);
  const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
  if (!proceed()) return failures;
  try {
    await context.registry.close();
  } catch (error) {
    failures.push(error);
  }
  if (!proceed()) return failures;
  try {
    (context.db as unknown as { $client: { close(): void } }).$client.close();
  } catch (error) {
    failures.push(error);
  }
  return failures;
}
