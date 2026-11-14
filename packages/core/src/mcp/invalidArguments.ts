import { SHARED_TOOL_INPUT_SCHEMAS } from './tools.generated.js';

/**
 * Telemetry for tool calls whose arguments do not match the tool's input schema. Products share
 * this mapping so self-hosted and Cloud report the same argument names and reasons.
 *
 * Every reported value comes from a fixed list or from the tool's own input schema. Argument
 * values, array indices and keys a client invented are never reported.
 */

/** Why an argument was rejected, mapped from the validator's issue code. */
export const INVALID_ARGUMENT_REASONS = [
  'unknown_field',
  'wrong_type',
  'invalid_value',
  'too_small',
  'too_big',
  'missing',
  'invalid_format',
  'other',
] as const;
export type InvalidArgumentReason = (typeof INVALID_ARGUMENT_REASONS)[number];

/** Reported in place of an argument name that is neither in the tool's schema nor in the fixed allowlist. */
export const UNRECOGNIZED_ARGUMENT = 'unrecognized_key';
/** Reported when the arguments as a whole were rejected, for example when they are not an object. */
export const ROOT_ARGUMENT = 'arguments';

/**
 * Undeclared argument names reported verbatim because they show what a model expected a tool to
 * accept. Argument names declared by any shared tool are added below.
 */
const COMMON_UNDECLARED_ARGUMENTS = [
  'after',
  'before',
  'body_format',
  'count',
  'cursor',
  'emailId',
  'email_id',
  'fields',
  'filter',
  'ids',
  'includeBody',
  'include_body',
  'isRead',
  'isUnread',
  'label',
  'limit',
  'max',
  'maxResults',
  'max_results',
  'message_id',
  'orderBy',
  'page',
  'page_size',
  'q',
  'search',
  'since',
  'sort',
  'thread_id',
  'unread',
  'unreadOnly',
  'until',
] as const;

/** Schema property names that are safe to report. Real ones are short identifiers. */
const ARGUMENT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX_PATH_STEPS = 8;

type JsonSchema = Record<string, unknown>;

function isSchema(value: unknown): value is JsonSchema {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function propertyNames(schema: unknown, names: Set<string>, depth = 0): Set<string> {
  if (!isSchema(schema) || depth > MAX_PATH_STEPS) return names;
  if (isSchema(schema.properties)) {
    for (const [name, child] of Object.entries(schema.properties)) {
      if (ARGUMENT_NAME.test(name)) names.add(name);
      propertyNames(child, names, depth + 1);
    }
  }
  for (const child of alternatives(schema)) propertyNames(child, names, depth + 1);
  if (isSchema(schema.items)) propertyNames(schema.items, names, depth + 1);
  return names;
}

let reportableNames: ReadonlySet<string> | undefined;

/** Built on first use so importing the module does not walk every schema. */
function reportableUndeclaredArguments(): ReadonlySet<string> {
  reportableNames ??= Object.values(SHARED_TOOL_INPUT_SCHEMAS).reduce(
    (names, schema) => propertyNames(schema, names),
    new Set<string>(COMMON_UNDECLARED_ARGUMENTS),
  );
  return reportableNames;
}

function alternatives(schema: JsonSchema): JsonSchema[] {
  return ['anyOf', 'oneOf', 'allOf'].flatMap((key) => {
    const list = schema[key];
    return Array.isArray(list) ? list.filter(isSchema) : [];
  });
}

/** The schema and its anyOf/oneOf/allOf branches, flattened a few levels deep. */
function branches(schema: JsonSchema, depth = 0): JsonSchema[] {
  if (depth > 3) return [schema];
  return [schema, ...alternatives(schema).flatMap((child) => branches(child, depth + 1))];
}

/** A validator issue. Zod issues have this shape; other validators can be adapted to it. */
export interface ArgumentIssue {
  code: string;
  path: readonly PropertyKey[];
  /** Undeclared keys, for `unrecognized_keys` issues. */
  keys?: readonly string[];
}

export interface InvalidArgumentProperties {
  /** Path of the first rejected argument, built from schema names and `[]` for array items. */
  invalid_argument: string;
  invalid_reason: InvalidArgumentReason;
  /** How many problems the call had, counting each undeclared key. */
  invalid_argument_count: number;
}

/**
 * Format a path through the input schema. Each step must be declared by the schema; the first step
 * that is not becomes {@link UNRECOGNIZED_ARGUMENT}, or the name itself when it is on the fixed
 * allowlist, and the path ends there.
 */
function schemaPath(inputSchema: JsonSchema, path: readonly PropertyKey[]): string {
  if (!path.length) return ROOT_ARGUMENT;
  let candidates = branches(inputSchema);
  let formatted = '';
  for (const step of path.slice(0, MAX_PATH_STEPS)) {
    if (typeof step === 'number') {
      const items = candidates.map((schema) => schema.items).filter(isSchema);
      if (!items.length) return `${formatted}[]`;
      formatted += '[]';
      candidates = items.flatMap((schema) => branches(schema));
      continue;
    }
    const name = String(step);
    const separator = formatted ? '.' : '';
    const declared = candidates
      .map((schema) =>
        isSchema(schema.properties) && Object.hasOwn(schema.properties, name) ? schema.properties[name] : undefined,
      )
      .filter(isSchema);
    if (declared.length && ARGUMENT_NAME.test(name)) {
      formatted += `${separator}${name}`;
      candidates = declared.flatMap((schema) => branches(schema));
      continue;
    }
    return `${formatted}${separator}${reportableUndeclaredArguments().has(name) ? name : UNRECOGNIZED_ARGUMENT}`;
  }
  return formatted;
}

/** Whether the raw arguments have no value at the path. Only used to tell `missing` from `wrong_type`. */
function absent(input: unknown, path: readonly PropertyKey[]): boolean {
  let value = input;
  for (const step of path) {
    if (value === null || typeof value !== 'object') return true;
    if (!Object.hasOwn(value, step)) return true;
    value = (value as Record<PropertyKey, unknown>)[step];
  }
  return value === undefined;
}

function reason(issue: ArgumentIssue, input: unknown): InvalidArgumentReason {
  switch (issue.code) {
    case 'unrecognized_keys':
      return 'unknown_field';
    case 'invalid_type':
    case 'invalid_union':
      if (absent(input, issue.path)) return 'missing';
      return issue.code === 'invalid_type' ? 'wrong_type' : 'invalid_value';
    case 'too_small':
      return 'too_small';
    case 'too_big':
      return 'too_big';
    case 'invalid_format':
      return 'invalid_format';
    case 'invalid_value':
    case 'invalid_key':
    case 'invalid_element':
    case 'not_multiple_of':
    case 'custom':
      return 'invalid_value';
    default:
      return 'other';
  }
}

/** One argument problem. An `unrecognized_keys` issue becomes one problem per undeclared key. */
export interface ArgumentProblem<Issue extends ArgumentIssue = ArgumentIssue> {
  issue: Issue;
  path: readonly PropertyKey[];
  unknownKey: boolean;
}

/**
 * Problems in the order Fluxmail reports them: undeclared keys first, because a misspelled
 * argument often causes the other problems. Error messages and telemetry both use this order.
 */
export function orderedArgumentProblems<Issue extends ArgumentIssue>(
  issues: readonly Issue[],
): ArgumentProblem<Issue>[] {
  return [
    ...issues.flatMap((issue) =>
      issue.code === 'unrecognized_keys'
        ? (issue.keys ?? []).map((key) => ({ issue, path: [...issue.path, key], unknownKey: true }))
        : [],
    ),
    ...issues
      .filter((issue) => issue.code !== 'unrecognized_keys')
      .map((issue) => ({ issue, path: issue.path, unknownKey: false })),
  ];
}

/**
 * Describe the first argument a tool call got wrong, for telemetry, in the order of
 * {@link orderedArgumentProblems}. Among undeclared keys, the first one that can be reported by
 * name wins, so a name such as `limit` is kept whatever order the client sent its keys in.
 *
 * `inputSchema` is the JSON Schema the tool advertises. `input` is the raw arguments, read only to
 * tell a missing argument from one with the wrong type.
 */
export function invalidArgumentProperties(
  inputSchema: Record<string, unknown>,
  issues: readonly ArgumentIssue[],
  input: unknown,
): InvalidArgumentProperties | undefined {
  const problems = orderedArgumentProblems(issues);
  const first = problems[0];
  if (!first) return undefined;
  const unknown = problems
    .filter((problem) => problem.unknownKey)
    .map((problem) => ({ problem, path: schemaPath(inputSchema, problem.path) }));
  const named = unknown.find((entry) => !entry.path.endsWith(UNRECOGNIZED_ARGUMENT)) ?? unknown[0];
  return {
    invalid_argument: named?.path ?? schemaPath(inputSchema, first.path),
    invalid_reason: reason(named?.problem.issue ?? first.issue, input),
    invalid_argument_count: problems.length,
  };
}
