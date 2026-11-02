import { createServer } from 'node:http';
import { connect } from 'node:net';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { EmailError } from '@fluxmail/core';
import { runOAuthCallbackFlow, type OAuthAuthUrlContext } from '../src/accounts/oauthCallback.js';

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind to a TCP port');
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function portIsFree(port: number): Promise<boolean> {
  const probe = createServer();
  return new Promise((resolve) => {
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

function startFlow(
  port: number,
  overrides: {
    complete?: (code: string) => Promise<{ email: string; value: string }>;
    paste?: boolean;
    timeoutMs?: number;
  } = {},
) {
  const input = new PassThrough();
  const written: string[] = [];
  const onCallback = vi.fn();
  const complete = vi.fn(overrides.complete ?? (async (code: string) => ({ email: 'me@example.com', value: code })));
  let announce!: (context: OAuthAuthUrlContext) => void;
  const announced = new Promise<OAuthAuthUrlContext>((resolve) => {
    announce = resolve;
  });
  const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
  const flow = runOAuthCallbackFlow({
    provider: 'gmail',
    redirectUri,
    host: '127.0.0.1',
    port,
    state: 'expected-state',
    authUrl: 'https://accounts.example.com/authorize',
    onAuthUrl: (_url, context) => announce(context),
    complete,
    options: {
      ...(overrides.paste === false ? {} : { paste: { input, write: (message) => written.push(message) } }),
      ...(overrides.timeoutMs ? { timeoutMs: overrides.timeoutMs } : {}),
      onCallback,
    },
  });
  return { flow, input, written, onCallback, complete, announced, redirectUri };
}

describe('OAuth callback flow', () => {
  it('finishes with a callback URL pasted from another computer', async () => {
    const port = await freePort();
    const { flow, input, onCallback, complete, announced, redirectUri } = startFlow(port);

    await expect(announced).resolves.toEqual({ listening: true, pasteEnabled: true });
    input.write(`  ${redirectUri}?state=expected-state&code=pasted-code&scope=email\n`);

    await expect(flow).resolves.toBe('pasted-code');
    expect(complete).toHaveBeenCalledOnce();
    expect(onCallback).toHaveBeenCalledWith('pasted');
    expect(await portIsFree(port)).toBe(true);
  });

  it('explains unusable pastes and keeps waiting for the right URL', async () => {
    const port = await freePort();
    const { flow, input, written, complete, announced, redirectUri } = startFlow(port);
    await announced;

    input.write('not a url\n');
    input.write(`http://127.0.0.1:${port}/somewhere-else?state=expected-state&code=x\n`);
    input.write(`${redirectUri}?state=old-state&code=stale-code\n`);
    input.write(`${redirectUri}?state=expected-state&code=fresh-code\n`);

    await expect(flow).resolves.toBe('fresh-code');
    expect(written).toEqual([
      expect.stringContaining('That is not a URL'),
      expect.stringContaining('not the Fluxmail callback'),
      expect.stringContaining('State mismatch'),
    ]);
    expect(complete).toHaveBeenCalledExactlyOnceWith('fresh-code', expect.any(URL));
  });

  it('reports a provider error from a pasted callback', async () => {
    const port = await freePort();
    const { flow, input, complete, announced, redirectUri } = startFlow(port);
    await announced;

    input.write(`${redirectUri}?state=expected-state&error=access_denied\n`);

    await expect(flow).rejects.toMatchObject({ code: 'invalid_request', message: 'Google OAuth error: access_denied' });
    expect(complete).not.toHaveBeenCalled();
  });

  it('exchanges only the first code and ignores later pastes and provider errors', async () => {
    const port = await freePort();
    let finishExchange!: () => void;
    const exchanging = new Promise<void>((resolve) => {
      finishExchange = resolve;
    });
    const { flow, input, written, onCallback, complete, announced, redirectUri } = startFlow(port, {
      complete: async (code) => {
        await exchanging;
        return { email: 'me@example.com', value: code };
      },
    });
    await announced;

    const browser = fetch(`${redirectUri}?state=expected-state&code=listener-code`);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    input.write(`${redirectUri}?state=expected-state&code=pasted-code\n`);
    await vi.waitFor(() =>
      expect(written).toContain('Fluxmail is already finishing this connection. Wait for it to complete.'),
    );
    const denied = await fetch(`${redirectUri}?state=expected-state&error=access_denied`);
    expect(denied.status).toBe(409);
    finishExchange();
    const page = await (await browser).text();

    await expect(flow).resolves.toBe('listener-code');
    expect(page).toContain('me@example.com is connected to Fluxmail');
    expect(complete).toHaveBeenCalledOnce();
    expect(onCallback).toHaveBeenCalledExactlyOnceWith('listener');
  });

  it('falls back to pasting when the callback port is taken', async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind to a TCP port');

    try {
      const { flow, input, announced, redirectUri } = startFlow(address.port);

      await expect(announced).resolves.toEqual({ listening: false, pasteEnabled: true });
      input.write(`${redirectUri}?state=expected-state&code=pasted-code\n`);
      await expect(flow).resolves.toBe('pasted-code');
    } finally {
      await new Promise<void>((resolve, reject) => occupied.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it('fails with the listener error when nobody can paste', async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind to a TCP port');

    try {
      const { flow } = startFlow(address.port, { paste: false });
      await expect(flow).rejects.toThrow(
        new RegExp(
          `port ${address.port} is already in use[\\s\\S]*docker compose exec fluxmail fluxmail accounts add gmail`,
        ),
      );
    } finally {
      await new Promise<void>((resolve, reject) => occupied.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it('times out with instructions for a browser on another computer', async () => {
    const port = await freePort();
    const { flow, announced, onCallback } = startFlow(port, { timeoutMs: 50 });
    await announced;

    const failure = await flow.catch((error: unknown) => error);
    expect(onCallback).toHaveBeenCalledExactlyOnceWith('timeout');

    expect(failure).toBeInstanceOf(EmailError);
    expect((failure as EmailError).message).toMatch(/^Timed out after 1 minute waiting for Google to redirect back/);
    expect((failure as EmailError).message).toContain('paste the URL from its address bar');
    expect((failure as EmailError).message).toContain(`ssh -L ${port}:127.0.0.1:${port}`);
    expect(await portIsFree(port)).toBe(true);
  });

  it('leaves out the paste hint on timeout when there is no terminal', async () => {
    const port = await freePort();
    const { flow } = startFlow(port, { paste: false, timeoutMs: 50 });

    await expect(flow).rejects.toThrow(/^(?![\s\S]*paste)Timed out/);
  });

  it('settles when the browser disconnects during the token exchange', async () => {
    const port = await freePort();
    let finishExchange!: () => void;
    const exchanging = new Promise<void>((resolve) => {
      finishExchange = resolve;
    });
    const { flow, complete, announced, redirectUri } = startFlow(port, {
      complete: async (code) => {
        await exchanging;
        return { email: 'me@example.com', value: code };
      },
    });
    await announced;

    const controller = new AbortController();
    const browser = fetch(`${redirectUri}?state=expected-state&code=listener-code`, { signal: controller.signal });
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    controller.abort();
    await browser.catch(() => undefined);
    finishExchange();

    await expect(flow).resolves.toBe('listener-code');
  });

  it('answers a malformed request without ending the flow', async () => {
    const port = await freePort();
    const { flow, input, announced, redirectUri } = startFlow(port);
    await announced;

    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => socket.write('GET // HTTP/1.1\r\nHost: x\r\n\r\n'));
      let data = '';
      socket.on('data', (chunk) => (data += chunk.toString()));
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
    expect(reply).toMatch(/^HTTP\/1\.1 400/);

    input.write(`${redirectUri}?state=expected-state&code=pasted-code\n`);
    await expect(flow).resolves.toBe('pasted-code');
  });

  it('stops waiting when input closes and the port is taken', async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind to a TCP port');

    try {
      const { flow, input, announced } = startFlow(address.port);
      await announced;
      input.end();
      await expect(flow).rejects.toThrow(/Input closed before a callback URL was pasted/);
    } finally {
      await new Promise<void>((resolve, reject) => occupied.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it('keeps listening when input closes and the listener is running', async () => {
    const port = await freePort();
    const { flow, input, announced, redirectUri } = startFlow(port);
    await announced;

    input.end();
    await new Promise((resolve) => setImmediate(resolve));
    await fetch(`${redirectUri}?state=expected-state&code=listener-code`);

    await expect(flow).resolves.toBe('listener-code');
  });
});
