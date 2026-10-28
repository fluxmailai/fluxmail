# Shared MCP tool contract

Self-hosted Fluxmail and Fluxmail Cloud offer 31 of the same MCP tools. `@fluxmail/core/mcp` publishes what the two products share as plain data, with no runtime dependencies and no Zod:

- `MAIL_SCOPES`, `PERMISSION_PRESETS` and `MODIFY_ACTION_SCOPES`
- `SHARED_TOOLS`: each tool's name, title, base description, scope (`null` for support tools), optional `alsoRequires` scope, annotations and input JSON Schema

`get_status`, `list_scheduled_emails` and `cancel_scheduled_email` are self-hosted only, and Cloud's `get_connection_status` is Cloud only. None of them are in the contract.

## Sources

Titles, descriptions, scopes and annotations are written by hand in `packages/core/src/mcp/tools.ts`. `buildServer.ts` reads them from `SHARED_TOOLS` and gates each shared tool on its contract scopes.

Input schemas stay in the server's Zod 3 shapes. `pnpm contract:generate` lists the server's tools over MCP and writes each shared tool's advertised input schema to `packages/core/src/mcp/tools.generated.ts`, then rebuilds core. Optional mail arguments accept `null`, as `tools/list` advertises them. Feedback defaults an omitted category to `other` and rejects `null`, matching Cloud. Schemas are inlined with no `$ref` pointers. CI runs `pnpm contract:check`, which fails when the generated file is stale.

## Input limits

Input limits live in the server's Zod shapes, so they reach the contract as `maxLength`, `maxItems` and `pattern`. A limit belongs in the shared schema only when both products can enforce it. Self-hosted leaves message bodies, the forward comment and the number of attachments unbounded below its request size limit, so Cloud states its own limits on those in its product descriptions.

## Product additions

A base description says what the tool does. It doesn't name other tools; the core tests reject other tool names. Feedback includes the explicit-request and private-data restrictions agents must follow. A product may append sentences to a base description but may not reword it. Self-hosted appends the sentences in `PRODUCT_DESCRIPTIONS` in `buildServer.ts`, including its pointers to other tools, and the attachment size limit on `download_attachment`.

Product-only arguments stay out of the generated schema. Self-hosted's only one is `send_email.sendAt`. The generator and `sharedToolContract.test.ts` each declare it, so adding another product-only argument means updating both.

## Tests

`packages/server/test/sharedToolContract.test.ts` is the parity guard. For each shared tool it checks that the advertised title and annotations equal the contract, the description starts with the base description, the input schema equals the contract schema plus only the declared product-only arguments, and the tool is listed only when the connection has each non-null `scope` and `alsoRequires`. A null scope grants no mailbox access. It also fails when the server lists a tool that is neither shared nor declared product-only.

`packages/server/test/fixtures/mcp-contract.json` remains the full `tools/list` snapshot, including output schemas and product-only tools.

## Changing a shared tool

Changes to a shared tool's name, arguments, annotations, scope or base description affect Cloud. Release a new `@fluxmail/core` version and tell the Cloud maintainers so Cloud can bump its pin and pass its own conformance test.

## Feedback contract handoff

`send_feedback` has `scope: null`, no `alsoRequires`, strict `message` and `category` arguments, and non-idempotent, non-destructive, open-world annotations. The shared description excludes Cloud-specific identity collection. Self-hosted appends its minimal intake payload description; Cloud must append `Cloud also sends your Cloud account and workspace IDs.` after the identical base description.

After publishing core, Cloud needs a separate dependency bump and contract snapshot refresh. Cloud must accept the null support scope without changing mail authorization, billing or quotas. Its existing category default and null rejection stay unchanged. The self-hosted client depends on the separate Cloud release providing `POST /api/feedback`; tests mock that endpoint and never send reports.

See [the Cloud agent prompt](cloud-feedback-handoff.md) for the dependency bump and registration changes.
