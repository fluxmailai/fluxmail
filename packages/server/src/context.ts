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
    const service = new EmailService(registry, db, undefined, config.encryptionKey, config.maxAttachmentBytes);
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
