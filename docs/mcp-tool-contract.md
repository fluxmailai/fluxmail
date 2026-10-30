# Shared MCP tool contract

Self-hosted Fluxmail and Fluxmail Cloud offer 31 of the same MCP tools. `@fluxmail/core/mcp` publishes what the two products share, with no runtime dependencies and no Zod:

- `MAIL_SCOPES`, `PERMISSION_PRESETS` and `MODIFY_ACTION_SCOPES`
- `SHARED_TOOLS`: each tool's name, title, base description, scope (`null` for support tools), optional `alsoRequires` scope, annotations, and input and output JSON Schemas
- Result shaping both products use: body and thread paging, modify action arguments, attachment resources and inline content, PDF text formatting, and MCP client classification for telemetry

`@fluxmail/core/mcp/pdf` runs PDF text extraction in memory-limited workers, at most two at a time per process. Each product supplies its own worker module, which depends on `unpdf`. `@fluxmail/core/search-cursor` signs search page tokens. Both subpaths need Node. The root `@fluxmail/core` export also holds the shared send and search behavior: reply sender selection, forward bodies, the search capability check and attachment download headers. The root and `mcp` exports use the global `Buffer`, so they need Node or a runtime that provides it.

`get_status`, `list_scheduled_emails` and `cancel_scheduled_email` are self-hosted only, and Cloud's `get_connection_status` is Cloud only. None of them are in the contract.

## Sources

Titles, descriptions, scopes and annotations are written by hand in `packages/core/src/mcp/tools.ts`. `buildServer.ts` reads them from `SHARED_TOOLS` and gates each shared tool on its contract scopes.

Input and output schemas stay in the server's Zod 3 shapes. `pnpm contract:generate` lists the server's tools over MCP and writes each shared tool's advertised input and output schemas to `packages/core/src/mcp/tools.generated.ts`, then rebuilds core. Messages, accounts, folders, labels, send-as identities, attachments, search pages, delivery operations and modify results allow additional properties, so a product may add fields to them. Other result objects, including the `data` wrapper, are closed. Optional mail arguments accept `null`, as `tools/list` advertises them. Feedback defaults an omitted category to `other` and rejects `null`, matching Cloud. Schemas are inlined with no `$ref` pointers. CI runs `pnpm contract:check`, which fails when the generated file is stale.

## Input limits

Input limits live in the server's Zod shapes, so they reach the contract as `maxLength`, `maxItems` and `pattern`. A limit belongs in the shared schema only when both products can enforce it. Self-hosted leaves message bodies, the forward comment and the number of attachments unbounded below its request size limit, so Cloud states its own limits on those in its product descriptions.

## Product additions

A base description says what the tool does. It doesn't name other tools; the core tests reject other tool names. Feedback includes the explicit-request and private-data restrictions agents must follow. A product may append sentences to a base description but may not reword it. Self-hosted appends the sentences in `PRODUCT_DESCRIPTIONS` in `buildServer.ts`, including its pointers to other tools, and the attachment size limit on `download_attachment`.

Product-only arguments stay out of the generated schema. Self-hosted's only one is `send_email.sendAt`. Results leave out `scheduleId`, which only self-hosted's scheduled sends return. The generator and `sharedToolContract.test.ts` each declare these, so adding another product-only argument or result field means updating both.

## Tests

`packages/server/test/sharedToolContract.test.ts` is the parity guard. For each shared tool it checks that the advertised title and annotations equal the contract, the description starts with the base description, the input schema equals the contract schema plus only the declared product-only arguments, the output schema equals the contract's, and the tool is listed only when the connection has each non-null `scope` and `alsoRequires`. A null scope grants no mailbox access. It also fails when the server lists a tool that is neither shared nor declared product-only.

`packages/server/test/fixtures/mcp-contract.json` remains the full `tools/list` snapshot, including product-only tools.

## Changing a shared tool

Changes to a shared tool's name, arguments, annotations, scope or base description affect Cloud. Release a new `@fluxmail/core` version and tell the Cloud maintainers so Cloud can bump its pin and pass its own conformance test.

## Feedback contract handoff

`send_feedback` has `scope: null`, no `alsoRequires`, and non-idempotent, non-destructive, open-world annotations. Its strict input requires `message` and accepts optional `category`, `contactEmail`, `requestId`, `toolName`, `errorCode`, `expectedBehavior` and `actualBehavior`. Omitted category defaults to `other`; all arguments reject `null`. The shared description requires explicit user consent for the message, diagnostics and exact reply address, forbids automatic selection of a connected mailbox address, and excludes Cloud-specific identity collection. Self-hosted appends its intake payload description and states that the reply address is user-provided and unverified. Cloud appends its own account-email and identity disclosures after the identical base description.

After publishing core, Cloud needs a separate dependency bump, removal of its Cloud-only feedback contract exception, and a contract snapshot refresh. Preserve its account-email default and private authenticated account metadata. Cloud must accept the null support scope without changing mail authorization, billing or quotas. Its existing category default and null rejection stay unchanged. Deploy Cloud's contact-email and diagnostic intake support before self-hosted clients use the new fields. The `201` response contains only the documented feedback fields, with the exact submitted reply address or none when omitted; server-only submission metadata must stay out of the response so strict clients remain compatible. Tests mock the intake and never send reports. No provider-adapter behavior changes are needed.

See [the Cloud agent prompt](cloud-feedback-handoff.md) for the dependency bump and registration changes.
