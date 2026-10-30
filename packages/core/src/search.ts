import { EmailError } from './errors.js';
import type {
  Capabilities,
  EmailQuery,
  PortableEmailQuery,
  PortableFolderRole,
  SearchAvailability,
  SearchCapabilities,
  SearchDiagnostic,
  SearchFilter,
} from './types.js';

declare const normalizedPortableEmailQuery: unique symbol;

export type NormalizedPortableEmailQuery = PortableEmailQuery & {
  readonly [normalizedPortableEmailQuery]: true;
};

export type NormalizeEmailQueryResult<T> =
  | { success: true; query: T }
  | { success: false; diagnostics: SearchDiagnostic[] };

export interface SearchToken {
  kind: 'text' | 'filter' | 'invalid';
  raw: string;
  value: string;
  start: number;
  end: number;
  field?: SearchFilter;
}

export type ParseEmailSearchResult =
  | {
      valid: true;
      query: NormalizedPortableEmailQuery;
      tokens: SearchToken[];
      diagnostics: SearchDiagnostic[];
    }
  | {
      valid: false;
      query: PortableEmailQuery;
      tokens: SearchToken[];
      diagnostics: SearchDiagnostic[];
    };

export type SearchRequirement =
  | { filter: Exclude<SearchFilter, 'folder'> }
  | { filter: 'folder'; role: PortableFolderRole };

export interface PortableEmailQuerySupport {
  supported: boolean;
  unsupported: SearchRequirement[];
  unknown: SearchRequirement[];
}

const PORTABLE_FOLDER_ROLES = [
  'inbox',
  'sent',
  'drafts',
  'archive',
  'spam',
  'trash',
  'all',
] as const satisfies readonly PortableFolderRole[];

const PORTABLE_FOLDER_ROLE_SET = new Set<string>(PORTABLE_FOLDER_ROLES);
const STRING_FIELDS = ['folder', 'text', 'from', 'to', 'subject', 'after', 'before', 'rawProviderQuery'] as const;
const PORTABLE_STRING_FIELDS = ['text', 'from', 'to', 'subject', 'after', 'before'] as const;
const DATE_FIELDS = ['after', 'before'] as const;
const FIELD_OPERATORS = ['from', 'to', 'subject', 'in', 'after', 'before'] as const;
const VALUE_OPERATORS = [
  'is:read',
  'is:unread',
  'is:starred',
  'is:unstarred',
  'has:attachment',
  '-has:attachment',
] as const;

interface Lexeme {
  raw: string;
  value: string;
  start: number;
  end: number;
  quoted: boolean;
  malformed: boolean;
}

function diagnostic(
  code: string,
  severity: 'error' | 'warning',
  message: string,
  lexeme?: Pick<Lexeme, 'start' | 'end'>,
  suggestion?: string,
): SearchDiagnostic {
  return {
    code,
    severity,
    message,
    ...(lexeme ? { start: lexeme.start, end: lexeme.end } : {}),
    ...(suggestion ? { suggestion } : {}),
  };
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function isPortableFolderRole(value: string): value is PortableFolderRole {
  return PORTABLE_FOLDER_ROLE_SET.has(value);
}

function normalizeString(value: string, collapseWhitespace = false): string {
  const trimmed = value.trim();
  return collapseWhitespace ? trimmed.replace(/\s+/g, ' ') : trimmed;
}

function normalizeQuery<T extends EmailQuery | PortableEmailQuery>(
  input: T,
  portable: boolean,
): NormalizeEmailQueryResult<T> {
  const query: Record<string, unknown> = {};
  const diagnostics: SearchDiagnostic[] = [];

  for (const field of STRING_FIELDS) {
    const value = (input as unknown as Record<string, unknown>)[field];
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      diagnostics.push(diagnostic('invalid_type', 'error', `${field} must be a string.`));
      continue;
    }
    const normalized = normalizeString(value, field === 'text');
    if (!normalized) {
      diagnostics.push(diagnostic('empty_value', 'error', `${field} cannot be empty.`));
      continue;
    }
    query[field] = normalized;
  }
  for (const field of ['read', 'starred', 'hasAttachment'] as const) {
    const value = (input as unknown as Record<string, unknown>)[field];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') {
      diagnostics.push(diagnostic('invalid_type', 'error', `${field} must be a boolean.`));
      continue;
    }
    query[field] = value;
  }

  if (portable && query.folder !== undefined && !PORTABLE_FOLDER_ROLE_SET.has(query.folder as string)) {
    diagnostics.push(
      diagnostic('unsupported_folder', 'error', `in must be one of: ${PORTABLE_FOLDER_ROLES.join(', ')}.`),
    );
  }
  if (portable && query.rawProviderQuery !== undefined) {
    diagnostics.push(
      diagnostic('unsupported_native_query', 'error', 'rawProviderQuery is not available in portable queries.'),
    );
  }
  if (query.text !== undefined && query.rawProviderQuery !== undefined) {
    diagnostics.push(diagnostic('conflicting_query', 'error', 'text cannot be combined with rawProviderQuery.'));
  }
  for (const field of DATE_FIELDS) {
    const value = query[field];
    if (typeof value === 'string' && !validDate(value)) {
      diagnostics.push(diagnostic('invalid_date', 'error', `${field} must use YYYY-MM-DD.`));
    }
  }
  if (
    typeof query.after === 'string' &&
    typeof query.before === 'string' &&
    validDate(query.after) &&
    validDate(query.before) &&
    query.after >= query.before
  ) {
    diagnostics.push(diagnostic('invalid_date_range', 'error', 'after must be earlier than before.'));
  }

  if (diagnostics.length) return { success: false, diagnostics };
  return { success: true, query: query as T };
}

export function normalizeEmailQuery(query: EmailQuery): NormalizeEmailQueryResult<EmailQuery> {
  return normalizeQuery(query, false);
}

export function normalizePortableEmailQuery(
  query: PortableEmailQuery,
): NormalizeEmailQueryResult<NormalizedPortableEmailQuery> {
  return normalizeQuery(query, true) as NormalizeEmailQueryResult<NormalizedPortableEmailQuery>;
}

export function mergeEmailQueries(
  parsed: PortableEmailQuery,
  structured: EmailQuery,
): NormalizeEmailQueryResult<EmailQuery> {
  const diagnostics: SearchDiagnostic[] = [];
  for (const field of [
    'folder',
    'text',
    'from',
    'to',
    'subject',
    'read',
    'starred',
    'hasAttachment',
    'after',
    'before',
  ] as const) {
    if (parsed[field] !== undefined && structured[field] !== undefined) {
      diagnostics.push(
        diagnostic('duplicate_filter', 'error', `${field} is set by both the typed query and a structured filter.`),
      );
    }
  }
  if (diagnostics.length) return { success: false, diagnostics };
  return normalizeEmailQuery({ ...parsed, ...structured });
}

function lex(input: string): Lexeme[] {
  const lexemes: Lexeme[] = [];
  let index = 0;
  while (index < input.length) {
    while (index < input.length && /\s/.test(input[index]!)) index += 1;
    if (index >= input.length) break;
    const start = index;
    let value = '';
    let quoted = false;
    let inQuote = false;
    let malformed = false;
    while (index < input.length) {
      const character = input[index]!;
      if (!inQuote && /\s/.test(character)) break;
      if (character === '"') {
        quoted = true;
        inQuote = !inQuote;
        index += 1;
        continue;
      }
      if (character === '\\' && inQuote) {
        const escaped = input[index + 1];
        if (escaped === '"' || escaped === '\\') {
          value += escaped;
          index += 2;
          continue;
        }
      }
      value += character;
      index += 1;
    }
    if (inQuote) malformed = true;
    lexemes.push({ raw: input.slice(start, index), value, start, end: index, quoted, malformed });
  }
  return lexemes;
}

function damerauLevenshtein(left: string, right: string): number {
  const rows = left.length + 1;
  const columns = right.length + 1;
  const matrix = Array.from({ length: rows }, () => Array<number>(columns).fill(0));
  for (let row = 0; row < rows; row += 1) matrix[row]![0] = row;
  for (let column = 0; column < columns; column += 1) matrix[0]![column] = column;
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      matrix[row]![column] = Math.min(
        matrix[row - 1]![column]! + 1,
        matrix[row]![column - 1]! + 1,
        matrix[row - 1]![column - 1]! + cost,
      );
      if (row > 1 && column > 1 && left[row - 1] === right[column - 2] && left[row - 2] === right[column - 1]) {
        matrix[row]![column] = Math.min(matrix[row]![column]!, matrix[row - 2]![column - 2]! + cost);
      }
    }
  }
  return matrix[left.length]![right.length]!;
}

function typoSuggestion(value: string): string | undefined {
  const normalized = value.toLowerCase();
  const valueOperator = VALUE_OPERATORS.find((candidate) => damerauLevenshtein(normalized, candidate) === 1);
  if (valueOperator) return valueOperator;

  const separator = normalized.indexOf(':');
  const field = separator > 0 ? normalized.slice(0, separator) : normalized;
  return FIELD_OPERATORS.find((candidate) => damerauLevenshtein(field, candidate) === 1);
}

function literalToken(lexeme: Lexeme, tokens: SearchToken[], text: string[]): void {
  tokens.push({
    kind: 'text',
    raw: lexeme.raw,
    value: lexeme.value,
    start: lexeme.start,
    end: lexeme.end,
  });
  if (lexeme.value) text.push(lexeme.value);
}

function invalidToken(lexeme: Lexeme, tokens: SearchToken[]): void {
  tokens.push({
    kind: 'invalid',
    raw: lexeme.raw,
    value: lexeme.value,
    start: lexeme.start,
    end: lexeme.end,
  });
}

export function parseEmailSearch(input: string): ParseEmailSearchResult {
  const query: PortableEmailQuery = {};
  const tokens: SearchToken[] = [];
  const diagnostics: SearchDiagnostic[] = [];
  const text: string[] = [];
  const assigned = new Map<keyof PortableEmailQuery, Lexeme>();

  if (!input.trim()) {
    const normalized = normalizePortableEmailQuery(query);
    if (normalized.success) {
      return {
        valid: true,
        query: normalized.query,
        tokens,
        diagnostics,
      };
    }
    return {
      valid: false,
      query,
      tokens,
      diagnostics: normalized.diagnostics,
    };
  }

  const assign = (field: keyof PortableEmailQuery, value: string | boolean, lexeme: Lexeme): boolean => {
    if (assigned.has(field)) {
      diagnostics.push(diagnostic('duplicate_filter', 'error', `${field} is specified more than once.`, lexeme));
      invalidToken(lexeme, tokens);
      return false;
    }
    assigned.set(field, lexeme);
    Object.assign(query, { [field]: value });
    tokens.push({
      kind: 'filter',
      raw: lexeme.raw,
      value: String(value),
      start: lexeme.start,
      end: lexeme.end,
      field: field === 'folder' ? 'folder' : (field as Exclude<SearchFilter, 'folder'>),
    });
    return true;
  };

  for (const lexeme of lex(input)) {
    if (lexeme.malformed) {
      diagnostics.push(diagnostic('malformed_quote', 'error', 'This quoted value is not closed.', lexeme));
      invalidToken(lexeme, tokens);
      continue;
    }

    const lower = lexeme.value.toLowerCase();
    const quotedLiteral = lexeme.quoted && lexeme.raw.startsWith('"');
    if (quotedLiteral) {
      if (!lexeme.value) {
        diagnostics.push(diagnostic('empty_value', 'error', 'Quoted search text cannot be empty.', lexeme));
        invalidToken(lexeme, tokens);
        continue;
      }
      literalToken(lexeme, tokens, text);
      continue;
    }

    const booleanOperator: Record<string, readonly [keyof PortableEmailQuery, boolean]> = {
      'is:read': ['read', true],
      'is:unread': ['read', false],
      'is:starred': ['starred', true],
      'is:unstarred': ['starred', false],
      'has:attachment': ['hasAttachment', true],
      '-has:attachment': ['hasAttachment', false],
    };
    const boolean = booleanOperator[lower];
    if (boolean) {
      assign(boolean[0], boolean[1], lexeme);
      continue;
    }

    const separator = lexeme.value.indexOf(':');
    const operator = separator > 0 ? lexeme.value.slice(0, separator).toLowerCase() : '';
    const value = separator > 0 ? lexeme.value.slice(separator + 1) : '';
    if ((FIELD_OPERATORS as readonly string[]).includes(operator)) {
      if (!value) {
        diagnostics.push(diagnostic('missing_value', 'error', `${operator}: requires a value.`, lexeme));
        invalidToken(lexeme, tokens);
        continue;
      }
      if (operator === 'in') {
        if (!PORTABLE_FOLDER_ROLE_SET.has(value.toLowerCase())) {
          diagnostics.push(
            diagnostic(
              'unsupported_folder',
              'error',
              `in: accepts ${PORTABLE_FOLDER_ROLES.join(', ')}. Use folder discovery for custom folders.`,
              lexeme,
            ),
          );
          invalidToken(lexeme, tokens);
          continue;
        }
        assign('folder', value.toLowerCase() as PortableFolderRole, lexeme);
        continue;
      }
      const field = operator as (typeof PORTABLE_STRING_FIELDS)[number];
      if ((field === 'after' || field === 'before') && !validDate(value)) {
        diagnostics.push(diagnostic('invalid_date', 'error', `${field}: must use YYYY-MM-DD.`, lexeme));
        invalidToken(lexeme, tokens);
        continue;
      }
      assign(field, value, lexeme);
      continue;
    }

    const isUrl = /^[a-z][a-z\d+.-]*:\/\//i.test(lexeme.value);
    const isTime = /^\d{1,2}:\d{2}(?::\d{2})?(?:[ap]m)?$/i.test(lexeme.value);
    if (!lexeme.quoted && !isUrl && !isTime) {
      const suggestion = typoSuggestion(lower);
      if (suggestion) {
        diagnostics.push(
          diagnostic(
            'possible_operator_typo',
            'warning',
            `Did you mean ${suggestion}${separator > 0 && !suggestion.includes(':') ? ':' : ''}?`,
            lexeme,
            suggestion,
          ),
        );
      }
    }
    literalToken(lexeme, tokens, text);
  }

  if (text.length) query.text = text.join(' ').replace(/\s+/g, ' ').trim();
  if (query.after && query.before && query.after >= query.before) {
    const afterToken = assigned.get('after')!;
    const beforeToken = assigned.get('before')!;
    const rejectedField = afterToken.start > beforeToken.start ? 'after' : 'before';
    const rejectedToken = assigned.get(rejectedField)!;
    delete query[rejectedField];
    const token = tokens.find(
      (candidate) => candidate.start === rejectedToken.start && candidate.end === rejectedToken.end,
    );
    if (token) {
      token.kind = 'invalid';
      delete token.field;
    }
    diagnostics.push(diagnostic('invalid_date_range', 'error', 'after must be earlier than before.', rejectedToken));
  }
  const normalized = normalizePortableEmailQuery(query);
  if (!normalized.success) diagnostics.push(...normalized.diagnostics);
  const valid = !diagnostics.some((item) => item.severity === 'error') && normalized.success;
  if (valid) return { valid: true, query: normalized.query, tokens, diagnostics };
  return { valid: false, query, tokens, diagnostics };
}

function quote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function formatEmailSearch(query: NormalizedPortableEmailQuery): string {
  const normalized = normalizePortableEmailQuery(query);
  if (!normalized.success || (query as EmailQuery).rawProviderQuery !== undefined) {
    throw new TypeError('formatEmailSearch requires a normalized portable email query.');
  }
  const q = normalized.query;
  const parts: string[] = [];
  if (q.folder) parts.push(`in:${q.folder}`);
  if (q.from) parts.push(`from:${quote(q.from)}`);
  if (q.to) parts.push(`to:${quote(q.to)}`);
  if (q.subject) parts.push(`subject:${quote(q.subject)}`);
  if (q.read !== undefined) parts.push(q.read ? 'is:read' : 'is:unread');
  if (q.starred !== undefined) parts.push(q.starred ? 'is:starred' : 'is:unstarred');
  if (q.hasAttachment !== undefined) parts.push(q.hasAttachment ? 'has:attachment' : '-has:attachment');
  if (q.after) parts.push(`after:${q.after}`);
  if (q.before) parts.push(`before:${q.before}`);
  if (q.text) parts.push(quote(q.text));
  return parts.join(' ');
}

export function requiredSearchFilters(query: PortableEmailQuery): SearchRequirement[] {
  const requirements: SearchRequirement[] = [];
  if (query.folder) requirements.push({ filter: 'folder', role: query.folder });
  for (const filter of [
    'text',
    'from',
    'to',
    'subject',
    'read',
    'starred',
    'hasAttachment',
    'after',
    'before',
  ] as const) {
    if (query[filter] !== undefined) requirements.push({ filter });
  }
  return requirements;
}

export function supportsPortableEmailQuery(
  capabilities: SearchCapabilities,
  query: PortableEmailQuery,
): PortableEmailQuerySupport {
  const unsupported: SearchRequirement[] = [];
  const unknown: SearchRequirement[] = [];
  for (const requirement of requiredSearchFilters(query)) {
    if (requirement.filter === 'folder') {
      if (!capabilities.filters.includes('folder')) {
        unsupported.push(requirement);
        continue;
      }
      const availability = capabilities.folderRoles[requirement.role];
      if (availability === 'unavailable') unsupported.push(requirement);
      if (availability === 'unknown') unknown.push(requirement);
    } else if (!capabilities.filters.includes(requirement.filter)) {
      unsupported.push(requirement);
    }
  }
  return { supported: unsupported.length === 0 && unknown.length === 0, unsupported, unknown };
}

/**
 * Throws unsupported_capability, naming the options, when this provider can't run the query.
 * includeSearchContext also requires the provider's search context support.
 */
export function assertSearchCapabilities(
  capabilities: Capabilities,
  query: EmailQuery,
  options: { includeSearchContext?: boolean } = {},
): void {
  const search = capabilities.search;
  const portableQuery: PortableEmailQuery = {
    ...(query.text !== undefined ? { text: query.text } : {}),
    ...(query.from !== undefined ? { from: query.from } : {}),
    ...(query.to !== undefined ? { to: query.to } : {}),
    ...(query.subject !== undefined ? { subject: query.subject } : {}),
    ...(query.read !== undefined ? { read: query.read } : {}),
    ...(query.starred !== undefined ? { starred: query.starred } : {}),
    ...(query.hasAttachment !== undefined ? { hasAttachment: query.hasAttachment } : {}),
    ...(query.after !== undefined ? { after: query.after } : {}),
    ...(query.before !== undefined ? { before: query.before } : {}),
    ...(query.folder && isPortableFolderRole(query.folder) ? { folder: query.folder } : {}),
  };
  const support = supportsPortableEmailQuery(search, portableQuery);
  const unsupported = support.unsupported.map((requirement) =>
    requirement.filter === 'folder' ? `folder:${requirement.role}` : requirement.filter,
  );
  if (query.folder && !isPortableFolderRole(query.folder) && !search.filters.includes('folder')) {
    unsupported.push('folder');
  }
  if (
    query.rawProviderQuery !== undefined &&
    (search.nativeQuery === null || search.nativeQuery.availability === 'unavailable')
  ) {
    unsupported.push('rawProviderQuery');
  }
  const unique = [...new Set(unsupported)];
  if (unique.length) {
    throw new EmailError(
      'unsupported_capability',
      `Unsupported search options for this provider: ${unique.join(', ')}.`,
      { unsupportedSearchOptions: unique },
    );
  }
  if (options.includeSearchContext && capabilities.searchContext !== true) {
    throw new EmailError('unsupported_capability', 'This provider does not support search context.');
  }
}

function intersectAvailability(values: readonly SearchAvailability[]): SearchAvailability {
  if (values.includes('unavailable')) return 'unavailable';
  if (values.includes('unknown')) return 'unknown';
  return 'available';
}

export function intersectSearchCapabilities(capabilities: readonly SearchCapabilities[]): SearchCapabilities {
  const filters = capabilities.length
    ? capabilities[0]!.filters.filter((filter) =>
        capabilities.slice(1).every((candidate) => candidate.filters.includes(filter)),
      )
    : [];
  const folderRoles = Object.fromEntries(
    PORTABLE_FOLDER_ROLES.map((role) => [
      role,
      capabilities.length
        ? intersectAvailability(capabilities.map((candidate) => candidate.folderRoles[role]))
        : 'unknown',
    ]),
  ) as Record<PortableFolderRole, SearchAvailability>;
  const native = capabilities.map((candidate) => candidate.nativeQuery);
  const syntax = native[0]?.syntax;
  const nativeQuery =
    syntax && native.every((candidate) => candidate?.syntax === syntax)
      ? {
          syntax,
          availability: intersectAvailability(native.map((candidate) => candidate!.availability)),
        }
      : null;
  return { filters, folderRoles, nativeQuery };
}
