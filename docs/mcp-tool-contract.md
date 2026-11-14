# Shared MCP tool contract

Self-hosted Fluxmail and Fluxmail Cloud offer 34 of the same MCP tools. `@fluxmail/core/mcp` publishes what the two products share, with no runtime dependencies and no Zod:

- `MAIL_SCOPES`, `PERMISSION_PRESETS` and `MODIFY_ACTION_SCOPES`
- `SHARED_TOOLS`: each tool's name, title, base description, scope (`null` for support tools), optional `alsoRequires` scope, annotations, and input and output JSON Schemas
- Result shaping both products use: body and thread paging, modify action arguments, attachment resources and inline content, PDF text formatting, and MCP client classification for telemetry

`@fluxmail/core/mcp/pdf` runs PDF text extraction in memory-limited workers, at most two at a time per process. Each product supplies its own worker module, which depends on `unpdf`. The worker calls `limitPdfWorkerMemory` from `@fluxmail/core/mcp/pdf-worker` before it loads pdf.js, and the returned `assertWithinLimit` before it posts a result: the worker heap limit doesn't cover the ArrayBuffers pdf.js decompresses streams into. `@fluxmail/core/search-cursor` signs search page tokens. Both subpaths need Node. The root `@fluxmail/core` export also holds the shared send and search behavior: reply sender selection, forward bodies, the search capability check and attachment download headers. The root and `mcp` exports use the global `Buffer`, so they need Node or a runtime that provides it.

## MCP Apps send confirmation

`@fluxmail/core/mcp` also publishes the MCP Apps card that shows a `preview_send` result as the email will be sent, with a Send button. Both products register it from these exports and copy no files:

- `SEND_CONFIRMATION_RESOURCE` for `resources/list`, and `sendConfirmationResourceContents()` for `resources/read` of `SEND_CONFIRMATION_RESOURCE_URI`. The contents hold `SEND_CONFIRMATION_HTML`, one self-contained document, and resource `_meta` with empty CSP domain lists and no permissions.
- `SEND_CONFIRMATION_TOOL_META`, the `_meta` that `preview_send`'s tool definition carries in `tools/list`.
- `sendConfirmationResultMeta({ idempotencyKey, body })`, the `_meta` a successful `preview_send` result carries under `SEND_CONFIRMATION_RESULT_META_KEY`. It holds the body as it will be sent, each part cut to `SEND_CONFIRMATION_MAX_BODY_CHARS`, the PNG, GIF, JPEG and WebP attachments the HTML shows as `cid:` images (as `data:` URLs, within `SEND_CONFIRMATION_MAX_IMAGE_CHARS` each and `SEND_CONFIRMATION_MAX_IMAGES_CHARS` in all), and the card's idempotency key. Self-hosted passes the resolved attachments of a direct send or reply; draft attachments carry no content, so their inline images stay placeholders. Content and `structuredContent` don't change.
- `issueSendConfirmationKey(secret, sendConfirmationContentHash(message))` makes that key for each preview. It is signed with a server secret and carries the preview time and a hash of the resolved message. `readSendConfirmationKey(secret, key)` returns `undefined` for any other key and `invalid` for a card key the server didn't sign or that is older than `SEND_CONFIRMATION_KEY_TTL_MS`.
- `clientSupportsMcpApps(capabilities)`. Offer the card unless it returns `false`. It returns `undefined` when a stateless request carries no client capabilities, and hosts without the extension ignore `_meta`.

The card's Send button calls `send_email` through the host with the `preview_send` tool input, the previewed `accountId` and the key from the result, so the server applies the same scope checks. When `send_email` receives a card key, the server refuses a key it can't read, then lets a repeat of the card's own send return the saved result. Otherwise it refuses the send when the message it resolves now no longer matches the previewed hash, or when the same member started a send or forward of the same email from that mailbox after the preview. Two deliveries are the same email when `sendConfirmationMatchHash(secret, message)` is equal: the set of To, Cc and Bcc addresses and the subject, ignoring case and spacing. Each product stores that digest with every send and forward once the message is resolved and before it goes out. A delivery with no digest counts as the same email, and so does any later send when the card's message can't be resolved, as when its draft is gone. A double click, re-render or retry delivers once, a card can't send after the model already sent the email, even reworded, an unrelated email doesn't block the card, and a draft changed after the preview isn't sent unseen. Self-hosted does this in its MCP `send_email` handler (`EmailService.checkConfirmedSend`), for immediate and scheduled sends; the secret is derived from the store's persistent secret, and the digest is the `match_hash` column of `delivery_operations` (store format 9). Before any send attempt, a plain-text body that isn't a saved draft can be edited in place: when the user finishes editing, the card calls `preview_send` again with the new `bodyText`, puts its current key in the request `_meta` under `SEND_CONFIRMATION_PREVIOUS_KEY_META`, and uses the new result's body and key. The new key keeps the earlier preview time, so the content check covers the edit and a send that overtook the first preview still blocks the card. A host that drops request `_meta` gets a key with the new preview's time, so only sends after the edit block it. The card shows each send outcome in a banner with a short title and the server's message, so keep those messages to a sentence or two. The server refuses to preview an edit whose previous key is a card key it can't read, such as an expired one. The card reports each send outcome to the model with `ui/update-model-context`, or a `ui/message` when the host refuses that; the send report repeats the edited body. An edit that isn't followed at once by a send is reported with `ui/update-model-context` only, so it never starts a model turn. Change the resource URI when the card changes incompatibly, because hosts may cache it by URI.

Member roles, mailbox sharing and credential reach are in `@fluxmail/core/access`; see [the shared access contract](access-contract.md).

`get_status` is self-hosted only, and Cloud's `get_connection_status` is Cloud only. Neither is in the contract.

## Sources

Titles, descriptions, scopes and annotations are written by hand in `packages/core/src/mcp/tools.ts`. `buildServer.ts` reads them from `SHARED_TOOLS` and gates each shared tool on its contract scopes.

Input and output schemas stay in the server's Zod shapes. `pnpm contract:generate` lists the server's tools over MCP and writes each shared tool's advertised input and output schemas to `packages/core/src/mcp/tools.generated.ts`, then rebuilds core. Messages, accounts, folders, labels, send-as identities, attachments, search pages, delivery operations and modify results allow additional properties, so a product may add fields to them. Other result objects, including the `data` wrapper, are closed. Optional mail arguments accept `null`, as `tools/list` advertises them. A tool that takes arguments rejects any it doesn't declare, including inside nested objects and when every argument is optional. The `invalid_request` error lists each unknown argument first, then any other invalid arguments. `list_accounts` takes no arguments and ignores any it receives in both products. Feedback defaults an omitted category to `other` and rejects `null`, matching Cloud. Schemas are inlined with no `$ref` pointers. CI runs `pnpm contract:check`, which fails when the generated file is stale.

## Aliases

`SHARED_TOOL_ALIASES` gives a shared tool another name. `search_emails` is an alias of `list_emails`, and `search_emails_batch` is an alias of `list_emails_batch`. An alias appears in `SHARED_TOOLS` with `aliasOf` set and the named tool's title, description, scopes, annotations and schemas, and both products register it with the same handler. The generated schema file holds only the named tool. Self-hosted reports an alias call under the alias's own operation name.

## Input limits

Input limits live in the server's Zod shapes, so they reach the contract as `maxLength`, `maxItems` and `pattern`. A limit belongs in the shared schema only when both products can enforce it. Self-hosted leaves message bodies, the forward comment and the number of attachments unbounded below its request size limit, so Cloud states its own limits on those in its product descriptions.

## Product additions

A base description says what the tool does. It doesn't name other tools; the core tests reject other tool names. Feedback includes the explicit-request and private-data restrictions agents must follow. A product may append sentences to a base description but may not reword it. Self-hosted appends the sentences in `PRODUCT_DESCRIPTIONS` in `buildServer.ts`, including its pointers to other tools, and the attachment size limit on `download_attachment`.

Product-only arguments and result fields stay out of the generated schema. Self-hosted has none now. The generator and `sharedToolContract.test.ts` each declare them, so adding one means updating both.

## Tests

`packages/server/test/sharedToolContract.test.ts` is the parity guard. For each shared tool it checks that the advertised title and annotations equal the contract, the description starts with the base description, the input schema equals the contract schema plus only the declared product-only arguments, the output schema equals the contract's, and the tool is listed only when the connection has each non-null `scope` and `alsoRequires`. A null scope grants no mailbox access. It also fails when the server lists a tool that is neither shared nor declared product-only.

`packages/server/test/fixtures/mcp-contract.json` remains the full `tools/list` snapshot, including product-only tools.

## Changing a shared tool

Changes to a shared tool's name, arguments, annotations, scope or base description affect Cloud. Release a new `@fluxmail/core` version and tell the Cloud maintainers so Cloud can bump its pin and pass its own conformance test. The CLI calls Cloud's tools too, so update `CloudMailBackend` as well; see [the CLI's Cloud connection](cli-cloud.md).

## Feedback contract handoff

`send_feedback` has `scope: null`, no `alsoRequires`, and non-idempotent, non-destructive, open-world annotations. Its strict input requires `message` and accepts optional `category`, `contactEmail`, `requestId`, `toolName`, `errorCode`, `expectedBehavior` and `actualBehavior`. Omitted category defaults to `other`; all arguments reject `null`. The shared description requires explicit user consent for the message, diagnostics and exact reply address, forbids automatic selection of a connected mailbox address, and excludes Cloud-specific identity collection. Self-hosted appends its intake payload description and states that the reply address is user-provided and unverified. Cloud appends its own account-email and identity disclosures after the identical base description.

After publishing core, Cloud needs a separate dependency bump, removal of its Cloud-only feedback contract exception, and a contract snapshot refresh. Preserve its account-email default and private authenticated account metadata. Cloud must accept the null support scope without changing mail authorization, billing or quotas. Its existing category default and null rejection stay unchanged. Deploy Cloud's contact-email and diagnostic intake support before self-hosted clients use the new fields. The `201` response contains only the documented feedback fields, with the exact submitted reply address or none when omitted; server-only submission metadata must stay out of the response so strict clients remain compatible. Tests mock the intake and never send reports. No provider-adapter behavior changes are needed.

See [the Cloud agent prompt](cloud-feedback-handoff.md) for the dependency bump and registration changes.
