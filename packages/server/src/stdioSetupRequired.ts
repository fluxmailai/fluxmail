import { existsSync } from 'node:fs';
import { hasInstanceProfiles } from './cliInstances.js';
import { resolveStoreLocation, type FluxmailStoreLocation } from './config.js';
import { EmailService } from './service/emailService.js';
import { SetupRequiredError } from './service/publicErrors.js';

/**
 * Returns the store location when the data directory has never been set up: no CLI profiles and no database.
 * Anything else, including a configuration error, goes through normal stdio startup, which reports it.
 */
export function newInstallationStore(): FluxmailStoreLocation | undefined {
  if (hasInstanceProfiles()) return undefined;
  let store: FluxmailStoreLocation;
  try {
    store = resolveStoreLocation();
  } catch {
    return undefined;
  }
  // An in-memory database is never set up on disk, so it is not a new installation either.
  if (store.dbPath === ':memory:' || existsSync(store.dbPath)) return undefined;
  return store;
}

/** The setup steps. Tool results leave out the directory because they reach the agent's model. */
export function setupRequiredMessage(dataDir?: string): string {
  const where = dataDir
    ? ` in ${dataDir}. Run "fluxmail setup" with this data directory`
    : '. Run "fluxmail setup" with the data directory this MCP client uses';
  return (
    `Fluxmail is not set up${where}, connect a mailbox with "fluxmail accounts add <provider>", ` +
    'then restart this MCP client.'
  );
}

/**
 * Stands in for the mail service when the data directory has never been set up. It holds no database,
 * member or mailbox, so every service method fails with the setup steps. Reading anything other than a
 * service method throws, so code that needs real service state fails loudly instead of using a stub.
 */
export function setupRequiredService(message: string): EmailService {
  return new Proxy(Object.create(null) as object, {
    get(_target, property) {
      // Never look like a promise, and stay inspectable.
      if (property === 'then' || typeof property === 'symbol') return undefined;
      if (typeof (EmailService.prototype as unknown as Record<string, unknown>)[property] !== 'function') {
        throw new TypeError(`EmailService.${property} is not available before setup.`);
      }
      return () => {
        throw new SetupRequiredError(message);
      };
    },
  }) as EmailService;
}
