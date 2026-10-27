# Shared MCP tool contract

Self-hosted Fluxmail and Fluxmail Cloud offer 30 of the same MCP tools. `@fluxmail/core/mcp` publishes what the two products share as plain data, with no runtime dependencies and no Zod:

- `MAIL_SCOPES`, `PERMISSION_PRESETS` and `MODIFY_ACTION_SCOPES`
- `SHARED_TOOLS`: each tool's name, title, base description, scope, optional `alsoRequires` scope, annotations and input JSON Schema

`get_status`, `list_scheduled_emails` and `cancel_scheduled_email` are self-hosted only, and Cloud's `get_connection_status` is Cloud only. None of them are in the contract.

## Sources

Titles, descriptions, scopes and annotations are written by hand in `packages/core/src/mcp/tools.ts`. `buildServer.ts` reads them from `SHARED_TOOLS` and gates each shared tool on its contract scopes.

Input schemas stay in the server's Zod 3 shapes. `pnpm contract:generate` lists the server's tools over MCP and writes each shared tool's advertised input schema to `packages/core/src/mcp/tools.generated.ts`, then rebuilds core. Optional arguments accept `null`, as `tools/list` advertises them. CI runs `pnpm contract:check`, which fails when the generated file is stale.

## Product additions

A product may append sentences to a base description but may not reword it. Self-hosted appends the sentences in `PRODUCT_DESCRIPTIONS` in `buildServer.ts`, and the attachment size limit on `download_attachment`.

Product-only arguments stay out of the generated schema. Self-hosted's only one is `send_email.sendAt`. The generator and `sharedToolContract.test.ts` each declare it, so adding another product-only argument means updating both.

## Tests

`packages/server/test/sharedToolContract.test.ts` is the parity guard. For each shared tool it checks that the advertised title and annotations equal the contract, the description starts with the base description, the input schema equals the contract schema plus only the declared product-only arguments, and the tool is listed only when the connection has `scope` and `alsoRequires`. It also fails when the server lists a tool that is neither shared nor declared product-only.

`packages/server/test/fixtures/mcp-contract.json` remains the full `tools/list` snapshot, including output schemas and product-only tools.

## Changing a shared tool

Changes to a shared tool's name, arguments, annotations, scope or base description affect Cloud. Release a new `@fluxmail/core` version and tell the Cloud maintainers so Cloud can bump its pin and pass its own conformance test.
