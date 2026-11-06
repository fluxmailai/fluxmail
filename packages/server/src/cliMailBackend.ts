import {
  EmailError,
  formatAddress,
  formatEmailSearch,
  mergeEmailQueries,
  normalizePortableEmailQuery,
  parseEmailSearch,
  type EmailAddress,
  type SearchDiagnostic,
} from '@fluxmail/core';
import { CloudClient } from './cliCloudClient.js';
import {
  instanceClient,
  instanceResponseError,
  resolveInstance,
  withLocalFailure,
  type ApiEnvelope,
  type CloudInstanceProfile,
  type InstanceClient,
} from './cliInstances.js';

export interface MailQuery {
  folder?: string;
  text?: string;
  from?: string;
  to?: string;
  subject?: string;
  read?: boolean;
  starred?: boolean;
  hasAttachment?: boolean;
  after?: string;
  before?: string;
  rawProviderQuery?: string;
  pageSize?: string;
  pageToken?: string;
  includeSnippet?: boolean;
  includeSearchContext?: boolean;
}

export interface DeliveryResult {
  status: string;
  error?: { code: string };
}

export interface BatchSearchGroup {
  accountId: string;
  error?: unknown;
}

export interface ModifyResult {
  failed: unknown[];
  uncertainIds: string[];
}

export interface DownloadedAttachment {
  content: Buffer;
  mimeType?: string;
  warning?: string;
}

type JsonBody = Record<string, unknown>;

/**
 * What the mail commands need from an instance. REST instances and Fluxmail
 * Cloud expose the same mail under different APIs; each backend returns the
 * envelope the commands print, so output doesn't depend on the instance kind.
 */
export interface MailBackend {
  resolveAccountId(requested?: string): Promise<string>;
  status(): Promise<unknown>;
  listAccounts(): Promise<unknown>;
  listSendAs(accountId: string): Promise<unknown>;
  listFolders(accountId: string): Promise<ApiEnvelope<unknown>>;
  listLabels(accountId: string): Promise<ApiEnvelope<unknown>>;
  listMessages(accountId: string, query: MailQuery, typedQuery?: string): Promise<ApiEnvelope<unknown[]>>;
  searchBatch(request: JsonBody): Promise<ApiEnvelope<BatchSearchGroup[]>>;
  getMessage(accountId: string, messageId: string, includeHeaders: boolean): Promise<ApiEnvelope<unknown>>;
  getThread(accountId: string, threadId: string): Promise<ApiEnvelope<unknown>>;
  send(accountId: string, request: JsonBody, idempotencyKey: string): Promise<ApiEnvelope<DeliveryResult>>;
  previewSend(accountId: string, request: JsonBody): Promise<ApiEnvelope<unknown>>;
  forward(
    accountId: string,
    messageId: string,
    request: JsonBody,
    idempotencyKey: string,
  ): Promise<ApiEnvelope<DeliveryResult>>;
  deliveryStatus(accountId: string, operationId: string): Promise<ApiEnvelope<unknown>>;
  modify(accountId: string, request: JsonBody): Promise<ApiEnvelope<ModifyResult>>;
  getDraft(accountId: string, draftId: string): Promise<ApiEnvelope<unknown>>;
  createDraft(accountId: string, request: JsonBody): Promise<ApiEnvelope<unknown>>;
  updateDraft(accountId: string, draftId: string, request: JsonBody): Promise<ApiEnvelope<unknown>>;
  deleteDraft(accountId: string, draftId: string): Promise<ApiEnvelope<unknown>>;
  listScheduled(accountId: string): Promise<ApiEnvelope<unknown>>;
  cancelScheduled(accountId: string, scheduleId: string): Promise<ApiEnvelope<unknown>>;
  downloadAttachment(accountId: string, messageId: string, attachmentId: string): Promise<DownloadedAttachment>;
}

interface AccountSummary {
  id: string;
  email: string;
  ownerMemberId: string;
  sharedWithAll: boolean;
  grantedMemberIds: string[];
}

function queryString(options: MailQuery, typedQuery?: string): string {
  const query = new URLSearchParams();
  for (const [key, value] of [
    ['folder', options.folder],
    ['query', typedQuery],
    ['text', options.text],
    ['from', options.from],
    ['to', options.to],
    ['subject', options.subject],
    ['after', options.after],
    ['before', options.before],
    ['rawProviderQuery', options.rawProviderQuery],
    ['pageSize', options.pageSize],
    ['pageToken', options.pageToken],
  ] as const) {
    if (value !== undefined) query.set(key, value);
  }
  if (options.read !== undefined) query.set('read', String(options.read));
  if (options.starred !== undefined) query.set('starred', String(options.starred));
  if (options.hasAttachment !== undefined) query.set('hasAttachment', String(options.hasAttachment));
  if (options.includeSnippet !== undefined) query.set('includeSnippet', String(options.includeSnippet));
  if (options.includeSearchContext !== undefined) {
    query.set('includeSearchContext', String(options.includeSearchContext));
  }
  return query.size ? `?${query}` : '';
}

function jsonRequest(body: JsonBody, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

async function responseError(response: Response): Promise<never> {
  let error: { code?: string; message?: string; data?: Record<string, unknown>; requestId?: string } | undefined;
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; data?: Record<string, unknown>; requestId?: string };
    };
    error = body.error;
  } catch {
    // The fallback below does not expose response content.
  }
  throw withLocalFailure(
    instanceResponseError(
      error?.code ?? 'request_failed',
      error?.message ?? `Request failed with HTTP ${response.status}.`,
      response.status,
      error?.data,
      error?.requestId,
    ),
    response,
  );
}

function accountPath(accountId: string, suffix = ''): string {
  return `/api/v1/accounts/${encodeURIComponent(accountId)}${suffix}`;
}

function draftPath(accountId: string, draftId: string): string {
  return accountPath(accountId, `/drafts/${encodeURIComponent(draftId)}`);
}

/** Choose one mailbox the same way on every instance kind. */
function chooseAccount<T extends { id: string; email: string }>(accounts: T[], requested?: string): string {
  if (requested) {
    const normalized = requested.toLowerCase();
    const account = accounts.find(
      (candidate) => candidate.id === requested || candidate.email.toLowerCase() === normalized,
    );
    if (!account) throw new EmailError('not_found', `No accessible account has id or email "${requested}".`);
    return account.id;
  }
  if (accounts.length === 0) {
    throw new EmailError('invalid_request', 'No email accounts are accessible to this member.');
  }
  if (accounts.length > 1) {
    throw new EmailError(
      'invalid_request',
      `Multiple accounts are available. Pass --mail-account or -a with one of: ${accounts
        .map((account) => `${account.id} (${account.email})`)
        .join(', ')}.`,
    );
  }
  return accounts[0]!.id;
}

export class RestMailBackend implements MailBackend {
  constructor(private readonly client: InstanceClient) {}

  async resolveAccountId(requested?: string): Promise<string> {
    const requestedRef = requested?.trim();
    if (requestedRef && /^acct_[^@\s]+$/.test(requestedRef)) return requestedRef;

    const listed = await this.client.json<AccountSummary[]>('/api/v1/accounts');
    if (listed.length === 0) {
      throw new EmailError('invalid_request', 'No email accounts are available. Connect an account first.');
    }
    const member = await this.client.json<{ id: string }>('/api/v1/me');
    const accounts = listed.filter(
      (account) =>
        account.ownerMemberId === member.id || account.sharedWithAll || account.grantedMemberIds.includes(member.id),
    );
    return chooseAccount(accounts, requestedRef);
  }

  status(): Promise<unknown> {
    return this.client.json('/api/v1/status');
  }

  listAccounts(): Promise<unknown> {
    return this.client.json('/api/v1/accounts');
  }

  listSendAs(accountId: string): Promise<unknown> {
    return this.client.json(accountPath(accountId, '/send-as'));
  }

  listFolders(accountId: string): Promise<ApiEnvelope<unknown>> {
    return this.client.jsonEnvelope(accountPath(accountId, '/folders'));
  }

  listLabels(accountId: string): Promise<ApiEnvelope<unknown>> {
    return this.client.jsonEnvelope(accountPath(accountId, '/labels'));
  }

  listMessages(accountId: string, query: MailQuery, typedQuery?: string): Promise<ApiEnvelope<unknown[]>> {
    return this.client.jsonEnvelope(accountPath(accountId, `/messages${queryString(query, typedQuery)}`));
  }

  searchBatch(request: JsonBody): Promise<ApiEnvelope<BatchSearchGroup[]>> {
    return this.client.jsonEnvelope('/api/v1/messages/search', jsonRequest(request));
  }

  getMessage(accountId: string, messageId: string, includeHeaders: boolean): Promise<ApiEnvelope<unknown>> {
    return this.client.jsonEnvelope(
      accountPath(accountId, `/messages/${encodeURIComponent(messageId)}`) +
        (includeHeaders ? '?includeHeaders=true' : ''),
    );
  }

  getThread(accountId: string, threadId: string): Promise<ApiEnvelope<unknown>> {
    return this.client.jsonEnvelope(accountPath(accountId, `/threads/${encodeURIComponent(threadId)}`));
  }

  send(accountId: string, request: JsonBody, idempotencyKey: string): Promise<ApiEnvelope<DeliveryResult>> {
    return this.client.jsonEnvelope(
      accountPath(accountId, '/send'),
      jsonRequest(request, { 'idempotency-key': idempotencyKey }),
    );
  }

  previewSend(accountId: string, request: JsonBody): Promise<ApiEnvelope<unknown>> {
    return this.client.jsonEnvelope(accountPath(accountId, '/send/preview'), jsonRequest(request));
  }

  forward(
    accountId: string,
    messageId: string,
    request: JsonBody,
    idempotencyKey: string,
  ): Promise<ApiEnvelope<DeliveryResult>> {
    return this.client.jsonEnvelope(
      accountPath(accountId, `/messages/${encodeURIComponent(messageId)}/forward`),
      jsonRequest(request, { 'idempotency-key': idempotencyKey }),
    );
  }

  deliveryStatus(accountId: string, operationId: string): Promise<ApiEnvelope<unknown>> {
    return this.client.jsonEnvelope(accountPath(accountId, `/delivery-operations/${encodeURIComponent(operationId)}`));
  }

  modify(accountId: string, request: JsonBody): Promise<ApiEnvelope<ModifyResult>> {
    return this.client.jsonEnvelope(accountPath(accountId, '/messages/actions'), jsonRequest(request));
  }

  getDraft(accountId: string, draftId: string): Promise<ApiEnvelope<unknown>> {
    return this.client.jsonEnvelope(draftPath(accountId, draftId));
  }

  createDraft(accountId: string, request: JsonBody): Promise<ApiEnvelope<unknown>> {
    return this.client.jsonEnvelope(accountPath(accountId, '/drafts'), jsonRequest(request));
  }

  updateDraft(accountId: string, draftId: string, request: JsonBody): Promise<ApiEnvelope<unknown>> {
    return this.client.jsonEnvelope(draftPath(accountId, draftId), { ...jsonRequest(request), method: 'PUT' });
  }

  deleteDraft(accountId: string, draftId: string): Promise<ApiEnvelope<unknown>> {
    return this.client.jsonEnvelope(draftPath(accountId, draftId), { method: 'DELETE' });
  }

  listScheduled(accountId: string): Promise<ApiEnvelope<unknown>> {
    return this.client.jsonEnvelope(accountPath(accountId, '/scheduled-sends'));
  }

  cancelScheduled(accountId: string, scheduleId: string): Promise<ApiEnvelope<unknown>> {
    return this.client.jsonEnvelope(accountPath(accountId, `/scheduled-sends/${encodeURIComponent(scheduleId)}`), {
      method: 'DELETE',
    });
  }

  async downloadAttachment(accountId: string, messageId: string, attachmentId: string): Promise<DownloadedAttachment> {
    const response = await this.client.request(
      accountPath(
        accountId,
        `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      ),
    );
    if (!response.ok) await responseError(response);
    return {
      content: Buffer.from(await response.arrayBuffer()),
      mimeType: response.headers.get('content-type') ?? undefined,
      warning: response.headers.get('fluxmail-warning') ?? undefined,
    };
  }
}

/** The tool for each REST modify action. */
const MODIFY_TOOLS: Record<string, string> = {
  markRead: 'mark_emails_read',
  markUnread: 'mark_emails_unread',
  star: 'star_emails',
  unstar: 'unstar_emails',
  archive: 'archive_emails',
  trash: 'trash_emails',
  untrash: 'restore_emails',
  delete: 'delete_emails',
  move: 'move_emails',
  addLabels: 'add_labels',
  removeLabels: 'remove_labels',
};

interface MessagePage {
  items: unknown[];
  [key: string]: unknown;
}

interface ToolMessage {
  id: string;
  body?: { text?: string; html?: string };
  bodyTruncation?: Record<string, { nextOffset?: number }>;
}

interface ToolThread {
  messages: ToolMessage[];
  nextPageToken?: string;
}

function schedulingUnavailable(): EmailError {
  return new EmailError('unsupported_capability', 'Fluxmail Cloud does not offer scheduled sending.');
}

function addressStrings(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map((item) => (typeof item === 'string' ? item : formatAddress(item as EmailAddress)))
    : value;
}

/** Tool arguments from a REST message body, so `--input` files work on every instance kind. */
function toolMessage(request: JsonBody): JsonBody {
  const { body, to, cc, bcc, ...rest } = request;
  const content = body as { text?: string; html?: string } | undefined;
  return {
    ...rest,
    ...(to !== undefined ? { to: addressStrings(to) } : {}),
    ...(cc !== undefined ? { cc: addressStrings(cc) } : {}),
    ...(bcc !== undefined ? { bcc: addressStrings(bcc) } : {}),
    ...(content?.text !== undefined ? { bodyText: content.text } : {}),
    ...(content?.html !== undefined ? { bodyHtml: content.html } : {}),
  };
}

function toolQuery(query: MailQuery): JsonBody {
  const { pageSize, ...rest } = query;
  const size = pageSize === undefined ? undefined : Number(pageSize);
  if (size !== undefined && (!Number.isInteger(size) || size < 1 || size > 100)) {
    throw new EmailError('invalid_request', '--page-size must be between 1 and 100.');
  }
  return {
    ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)),
    ...(size !== undefined ? { pageSize: size } : {}),
  };
}

function invalidSearch(diagnostics: SearchDiagnostic[]): EmailError {
  return new EmailError('invalid_request', diagnostics.map((item) => item.message).join(' '), { diagnostics });
}

type MailFilters = Omit<MailQuery, 'pageSize' | 'pageToken' | 'includeSnippet' | 'includeSearchContext'>;

/**
 * Cloud's list tools filter only through a typed query, folder and rawProviderQuery. The user's query is
 * sent unchanged, so Cloud reports its own warnings, and each filter flag the query doesn't already set is
 * appended as typed syntax. Conflicts are rejected first, with the rules the server applies.
 */
function typedFilters(filterFlags: MailFilters, typedQuery?: string): JsonBody {
  // Like the server, treat blank flags as unset.
  const flags = Object.fromEntries(
    Object.entries(filterFlags).filter(([, value]) => value !== undefined && String(value).trim() !== ''),
  ) as MailFilters;
  const parsed = typedQuery === undefined ? undefined : parseEmailSearch(typedQuery);
  if (parsed && !parsed.valid) throw invalidSearch(parsed.diagnostics);
  const merged = mergeEmailQueries(parsed?.query ?? {}, flags);
  if (!merged.success) throw invalidSearch(merged.diagnostics);
  const { folder, rawProviderQuery, ...filters } = flags;
  // A flag the query already sets has the same value, so only text, which joins, and missing filters are added.
  const missing = Object.fromEntries(
    Object.entries(filters).filter(
      ([key]) => key === 'text' || parsed?.query[key as keyof typeof parsed.query] === undefined,
    ),
  );
  const added = normalizePortableEmailQuery(missing);
  if (!added.success) throw invalidSearch(added.diagnostics);
  const typed = [typedQuery?.trim(), formatEmailSearch(added.query)].filter(Boolean).join(' ');
  return {
    ...(typed ? { query: typed } : {}),
    ...(folder !== undefined ? { folder } : {}),
    ...(rawProviderQuery !== undefined ? { rawProviderQuery } : {}),
  };
}

function listEmailsArgs(query: MailQuery, typedQuery?: string): JsonBody {
  const { pageSize, pageToken, includeSnippet, includeSearchContext, ...filters } = query;
  return {
    ...toolQuery({ pageSize, pageToken, includeSnippet, includeSearchContext }),
    ...typedFilters(filters, typedQuery),
  };
}

/** The REST batch body, with its structured filters turned into list_emails_batch's typed query. */
function listEmailsBatchArgs(request: JsonBody): JsonBody {
  const { accounts, query, pageSize, includeSnippet, includeSearchContext, ...filters } = request;
  return {
    accounts,
    ...typedFilters(filters as MailFilters, typeof query === 'string' ? query : undefined),
    ...(pageSize !== undefined ? { pageSize } : {}),
    ...(includeSnippet !== undefined ? { includeSnippet } : {}),
    ...(includeSearchContext !== undefined ? { includeSearchContext } : {}),
  };
}

function pageEnvelope(page: MessagePage): { data: unknown[]; meta: Record<string, unknown> } {
  const { items, ...meta } = page;
  return { data: items, meta };
}

export class CloudMailBackend implements MailBackend {
  private readonly client: CloudClient;

  constructor(instance: string, profile: CloudInstanceProfile, apiKey?: string) {
    this.client = new CloudClient(instance, profile.serverUrl, apiKey);
  }

  async resolveAccountId(requested?: string): Promise<string> {
    const requestedRef = requested?.trim();
    if (requestedRef && !requestedRef.includes('@')) return requestedRef;
    // Unlike list_accounts, this tool works with any mail permission and isn't metered.
    const { mailboxes } = await this.client.callTool<{ mailboxes: Array<{ id: string; email: string }> }>(
      'get_connection_status',
    );
    return chooseAccount(mailboxes, requestedRef);
  }

  status(): Promise<unknown> {
    return this.client.callTool('get_connection_status');
  }

  listAccounts(): Promise<unknown> {
    return this.client.callTool('list_accounts');
  }

  listSendAs(accountId: string): Promise<unknown> {
    return this.client.callTool('list_send_as', { accountId });
  }

  private async envelope<T>(tool: string, args: JsonBody): Promise<ApiEnvelope<T>> {
    return { data: await this.client.callTool<T>(tool, args) };
  }

  listFolders(accountId: string): Promise<ApiEnvelope<unknown>> {
    return this.envelope('list_folders', { accountId });
  }

  listLabels(accountId: string): Promise<ApiEnvelope<unknown>> {
    return this.envelope('list_labels', { accountId });
  }

  async listMessages(accountId: string, query: MailQuery, typedQuery?: string): Promise<ApiEnvelope<unknown[]>> {
    return pageEnvelope(
      await this.client.callTool<MessagePage>('list_emails', { ...listEmailsArgs(query, typedQuery), accountId }),
    );
  }

  async searchBatch(request: JsonBody): Promise<ApiEnvelope<BatchSearchGroup[]>> {
    const { groups, exhausted } = await this.client.callTool<{
      groups: Array<BatchSearchGroup & { page?: MessagePage }>;
      exhausted: boolean;
    }>('list_emails_batch', listEmailsBatchArgs(request));
    return {
      data: groups.map(({ page, ...group }) => (page ? { ...group, ...pageEnvelope(page) } : group)),
      meta: { exhausted },
    };
  }

  /** MCP results cap body length, and these commands promise the whole message. */
  private async completeBody(accountId: string, message: ToolMessage): Promise<ToolMessage> {
    const { bodyTruncation, ...complete } = message;
    for (const format of ['text', 'html'] as const) {
      let offset = bodyTruncation?.[format]?.nextOffset;
      let value = complete.body?.[format] ?? '';
      while (offset !== undefined) {
        const page: { text: string; nextOffset?: number } = await this.client.callTool('get_email_body', {
          accountId,
          messageId: message.id,
          format,
          offset,
        });
        value += page.text;
        offset = page.nextOffset;
      }
      if (bodyTruncation?.[format]?.nextOffset !== undefined) complete.body = { ...complete.body, [format]: value };
    }
    return complete;
  }

  async getMessage(accountId: string, messageId: string, includeHeaders: boolean): Promise<ApiEnvelope<unknown>> {
    const message = await this.client.callTool<ToolMessage>('get_email', {
      accountId,
      messageId,
      ...(includeHeaders ? { includeHeaders: true } : {}),
    });
    return { data: await this.completeBody(accountId, message) };
  }

  async getThread(accountId: string, threadId: string): Promise<ApiEnvelope<unknown>> {
    const first = await this.client.callTool<ToolThread>('get_thread', { accountId, threadId });
    const pages = [first];
    for (let token = first.nextPageToken; token;) {
      const page: ToolThread = await this.client.callTool('get_thread', { accountId, threadId, pageToken: token });
      pages.push(page);
      token = page.nextPageToken;
    }
    const messages: ToolMessage[] = [];
    for (const message of pages.flatMap((page) => page.messages)) {
      messages.push(await this.completeBody(accountId, message));
    }
    const { nextPageToken: _nextPageToken, ...thread } = first;
    return { data: { ...thread, messages } };
  }

  send(accountId: string, request: JsonBody, idempotencyKey: string): Promise<ApiEnvelope<DeliveryResult>> {
    if (request.sendAt !== undefined) throw schedulingUnavailable();
    return this.envelope('send_email', { ...toolMessage(request), accountId, idempotencyKey });
  }

  previewSend(accountId: string, request: JsonBody): Promise<ApiEnvelope<unknown>> {
    return this.envelope('preview_send', { ...toolMessage(request), accountId });
  }

  forward(
    accountId: string,
    messageId: string,
    request: JsonBody,
    idempotencyKey: string,
  ): Promise<ApiEnvelope<DeliveryResult>> {
    return this.envelope('forward_email', { ...toolMessage(request), accountId, messageId, idempotencyKey });
  }

  deliveryStatus(accountId: string, operationId: string): Promise<ApiEnvelope<unknown>> {
    return this.envelope('get_delivery_operation', { accountId, operationId });
  }

  modify(accountId: string, request: JsonBody): Promise<ApiEnvelope<ModifyResult>> {
    const { action, ...args } = request;
    const tool = MODIFY_TOOLS[String(action)];
    if (!tool) throw new EmailError('invalid_request', `Unknown message action "${String(action)}".`);
    return this.envelope(tool, { ...args, accountId });
  }

  getDraft(accountId: string, draftId: string): Promise<ApiEnvelope<unknown>> {
    return this.envelope('get_draft', { accountId, draftId });
  }

  createDraft(accountId: string, request: JsonBody): Promise<ApiEnvelope<unknown>> {
    return this.envelope('create_draft', { ...toolMessage(request), accountId });
  }

  updateDraft(accountId: string, draftId: string, request: JsonBody): Promise<ApiEnvelope<unknown>> {
    return this.envelope('update_draft', { ...toolMessage(request), accountId, draftId });
  }

  deleteDraft(accountId: string, draftId: string): Promise<ApiEnvelope<unknown>> {
    return this.envelope('delete_draft', { accountId, draftId });
  }

  listScheduled(): Promise<ApiEnvelope<unknown>> {
    throw schedulingUnavailable();
  }

  cancelScheduled(): Promise<ApiEnvelope<unknown>> {
    throw schedulingUnavailable();
  }

  downloadAttachment(accountId: string, messageId: string, attachmentId: string): Promise<DownloadedAttachment> {
    return this.client.readAttachment(accountId, messageId, attachmentId);
  }
}

export function mailBackend(name?: string): MailBackend {
  const selected = resolveInstance(name);
  return selected.profile.kind === 'cloud'
    ? new CloudMailBackend(selected.name, selected.profile)
    : new RestMailBackend(instanceClient(name));
}
