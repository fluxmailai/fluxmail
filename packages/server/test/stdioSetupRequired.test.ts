import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { SetupRequiredError } from '../src/service/publicErrors.js';
import { setupRequiredMessage, setupRequiredService } from '../src/stdioSetupRequired.js';

describe('setup-required stdio service', () => {
  const service = setupRequiredService(setupRequiredMessage());

  it('fails every service method with the setup steps', () => {
    expect(() => service.listAccounts()).toThrow(SetupRequiredError);
    expect(() => service.enforceQuota()).toThrow(/Run "fluxmail setup" with the data directory this MCP client uses/);
  });

  it('rejects reads of anything that is not a service method', () => {
    expect(() => (service as unknown as Record<string, unknown>).maxAttachmentBytes).toThrow(TypeError);
  });

  it('is neither a promise nor uninspectable', async () => {
    expect((service as unknown as { then?: unknown }).then).toBeUndefined();
    await expect(Promise.resolve(service)).resolves.toBe(service);
    expect(() => inspect(service)).not.toThrow();
  });

  it('names the data directory only when asked to', () => {
    expect(setupRequiredMessage('/private/data')).toContain('Fluxmail is not set up in /private/data.');
    expect(setupRequiredMessage()).not.toContain('/private/data');
  });
});
