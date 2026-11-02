import { createServer, type ServerResponse } from 'node:http';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { EmailError } from '@fluxmail/core';

/** How the authorization code reached the CLI, or `timeout` when it never did. */
export type OAuthCallbackSource = 'listener' | 'pasted' | 'timeout';

/**
 * A terminal where the user can paste the callback URL from their browser's
 * address bar. This lets the flow finish when the browser runs on another
 * computer and the redirect cannot reach the CLI's listener.
 */
export interface OAuthPasteInput {
  input: Readable;
  /** Prints a follow-up message when a pasted value cannot be used. */
  write: (message: string) => void;
}

export interface OAuthAuthUrlContext {
  /** Whether the local listener is accepting the browser redirect. */
  listening: boolean;
  /** Whether the user can paste the callback URL instead. */
  pasteEnabled: boolean;
}

export interface LoopbackFlowOptions {
  paste?: OAuthPasteInput;
  /** Defaults to 10 minutes. */
  timeoutMs?: number;
  /** Called once: when a callback carrying an authorization code is accepted, or on timeout. */
  onCallback?: (source: OAuthCallbackSource) => void;
}

export const DEFAULT_OAUTH_CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;

type OAuthCallbackProvider = 'gmail' | 'outlook' | 'cloud';

interface CallbackFlowParams<T> {
  provider: OAuthCallbackProvider;
  redirectUri: string;
  host: string;
  port: number;
  state: string;
  authUrl: string;
  onAuthUrl: (url: string, context: OAuthAuthUrlContext) => void;
  /** Exchanges the code and stores the account. Its errors end the flow. */
  complete: (code: string, callback: URL) => Promise<{ email: string; value: T }>;
  /** The browser page's heading after `complete` succeeds. */
  successTitle?: (email: string) => string;
  options?: LoopbackFlowOptions;
}

type CallbackCheck =
  | { kind: 'ignore'; status: number; message: string }
  | { kind: 'error'; error: EmailError; message: string }
  | { kind: 'code'; code: string };

function providerName(provider: OAuthCallbackProvider): string {
  return { gmail: 'Google', outlook: 'Microsoft', cloud: 'Fluxmail Cloud' }[provider];
}

function checkCallback(url: URL, params: CallbackFlowParams<unknown>, callbackPath: string): CallbackCheck {
  if (url.pathname !== callbackPath) return { kind: 'ignore', status: 404, message: 'Not found' };
  if (url.searchParams.get('state') !== params.state) {
    return { kind: 'ignore', status: 400, message: 'State mismatch. Restart the flow.' };
  }
  const oauthError = url.searchParams.get('error');
  if (oauthError) {
    const description = url.searchParams.get('error_description') ?? oauthError;
    const name = providerName(params.provider);
    return {
      kind: 'error',
      error: new EmailError('invalid_request', `${name} OAuth error: ${description}`),
      message: `${name} returned an error: ${description}.`,
    };
  }
  const code = url.searchParams.get('code');
  if (!code) return { kind: 'ignore', status: 400, message: 'Missing code parameter.' };
  return { kind: 'code', code };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[char]!;
  });
}

function callbackPage(title: string, message: string): string {
  return (
    '<html><body style="font-family: sans-serif">' +
    `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p>` +
    '<p>You can close this tab and return to the terminal.</p></body></html>'
  );
}

function failureMessage(error: unknown): { status: number; message: string } {
  return error instanceof EmailError
    ? { status: 400, message: error.message }
    : { status: 500, message: 'Fluxmail could not finish connecting this account. Check the terminal for details.' };
}

function timeoutError(params: CallbackFlowParams<unknown>, timeoutMs: number): EmailError {
  const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
  const pasteHint = params.options?.paste
    ? 'If your browser runs on another computer, try again and paste the URL from its address bar ' +
      'after you approve access. '
    : '';
  return new EmailError(
    'invalid_request',
    `Timed out after ${minutes} minute${minutes === 1 ? '' : 's'} waiting for ${providerName(params.provider)} to redirect back. ` +
      pasteHint +
      `You can also forward the callback port with "ssh -L ${params.port}:127.0.0.1:${params.port} <server>".`,
  );
}

/** Explains a busy callback port, including the Docker Compose case where the container owns it. */
export function callbackPortInUseError(error: Error, port: number, provider: OAuthCallbackProvider): Error {
  if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') return error;
  if (provider === 'cloud')
    return new Error(`OAuth callback port ${port} is already in use. Try again.`, { cause: error });
  return new Error(
    `OAuth callback port ${port} is already in use.\n\n` +
      'If Fluxmail is running with Docker Compose, connect the account inside the container:\n\n' +
      `  docker compose exec fluxmail fluxmail accounts add ${provider}\n\n` +
      `Otherwise, stop the process using port ${port} and try again.`,
    { cause: error },
  );
}

/**
 * Waits for the OAuth redirect on the loopback listener and, when a terminal
 * is available, for the same callback URL pasted into it. The first callback
 * that carries a code wins, and the flow gives up after a timeout.
 */
export function runOAuthCallbackFlow<T>(params: CallbackFlowParams<T>): Promise<T> {
  const callbackPath = new URL(params.redirectUri).pathname;
  const paste = params.options?.paste;
  const timeoutMs = params.options?.timeoutMs ?? DEFAULT_OAUTH_CALLBACK_TIMEOUT_MS;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    // An authorization code is single use, so only the first one is exchanged.
    // Once a code is claimed, later callbacks, including provider errors, cannot end the flow.
    let claimed = false;
    let listening = false;
    let announced = false;

    const server = createServer((request, response) => {
      void handleRequest(request.url ?? '/', response);
    });
    const lines = paste ? createInterface({ input: paste.input, terminal: false }) : undefined;
    // The wait ends when a code is claimed. The token exchange that follows is
    // bounded by the provider request itself.
    const timer = setTimeout(() => {
      if (claimed) return;
      settle(() => {
        params.options?.onCallback?.('timeout');
        reject(timeoutError(params, timeoutMs));
      });
    }, timeoutMs);

    function cleanup(): void {
      clearTimeout(timer);
      lines?.close();
      if (listening) {
        // Responses carry Connection: close, so open sockets end once the page
        // is written. Force any stragglers shut so the CLI process can exit.
        server.close();
        server.closeIdleConnections();
        setTimeout(() => server.closeAllConnections(), 1000).unref();
      }
    }

    function settle(action: () => void): void {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    }

    function announce(): void {
      if (announced) return;
      announced = true;
      params.onAuthUrl(params.authUrl, { listening, pasteEnabled: paste !== undefined });
    }

    function busy(): boolean {
      return claimed || settled;
    }

    /** Exchange a claimed code, then report the outcome to whichever path supplied it. */
    async function exchange(
      source: 'listener' | 'pasted',
      code: string,
      callback: URL,
    ): Promise<{ email?: string; error?: unknown }> {
      claimed = true;
      params.options?.onCallback?.(source);
      try {
        const { email, value } = await params.complete(code, callback);
        settle(() => resolve(value));
        return { email };
      } catch (error) {
        settle(() => reject(error));
        return { error };
      }
    }

    function respond(response: ServerResponse, status: number, body: string, html = false): void {
      response
        .writeHead(status, {
          connection: 'close',
          'content-type': html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
        })
        .end(body);
    }

    async function handleRequest(rawUrl: string, response: ServerResponse): Promise<void> {
      let url: URL;
      try {
        url = new URL(rawUrl, params.redirectUri);
      } catch {
        respond(response, 400, 'Bad request');
        return;
      }
      const check = checkCallback(url, params, callbackPath);
      if (check.kind === 'ignore') {
        respond(response, check.status, check.message);
        return;
      }
      if (busy()) {
        respond(response, 409, 'This connection is already being completed. Return to the terminal.');
        return;
      }
      if (check.kind === 'error') {
        settle(() => reject(check.error));
        respond(response, 400, `${check.message} You can close this tab.`);
        return;
      }
      const outcome = await exchange('listener', check.code, url);
      if (outcome.email !== undefined) {
        respond(
          response,
          200,
          callbackPage(
            params.successTitle?.(outcome.email) ?? `${outcome.email} is connected to Fluxmail`,
            'The account is ready to use.',
          ),
          true,
        );
        return;
      }
      const failure = failureMessage(outcome.error);
      respond(response, failure.status, callbackPage('Fluxmail could not connect this account', failure.message), true);
    }

    async function handlePastedLine(line: string): Promise<void> {
      const text = line.trim();
      if (!text || settled) return;
      if (claimed) {
        paste!.write('Fluxmail is already finishing this connection. Wait for it to complete.');
        return;
      }
      let url: URL;
      try {
        url = new URL(text);
      } catch {
        paste!.write(
          'That is not a URL. Paste the full address from your browser, starting with ' +
            `${new URL(params.redirectUri).origin}.`,
        );
        return;
      }
      const check = checkCallback(url, params, callbackPath);
      if (check.kind === 'ignore') {
        paste!.write(
          check.status === 404
            ? `That URL is not the Fluxmail callback. It should start with ${params.redirectUri}.`
            : `${check.message} Paste the URL from the most recent authorization.`,
        );
        return;
      }
      if (check.kind === 'error') {
        settle(() => reject(check.error));
        return;
      }
      await exchange('pasted', check.code, url);
    }

    lines?.on('line', (line) => void handlePastedLine(line));
    lines?.on('close', () => {
      // With the listener running, the browser redirect can still finish the flow.
      if (settled || claimed || listening) return;
      settle(() =>
        reject(
          new EmailError(
            'invalid_request',
            'Input closed before a callback URL was pasted, and the callback port is in use. Run the command again.',
          ),
        ),
      );
    });

    server.on('error', (error) => {
      if (listening || settled) return;
      // Without a terminal, the listener is the only way to finish.
      if (!paste || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
        settle(() => reject(callbackPortInUseError(error, params.port, params.provider)));
        return;
      }
      announce();
    });
    server.listen(params.port, params.host, () => {
      listening = true;
      if (settled) {
        server.close();
        return;
      }
      announce();
    });
  });
}
