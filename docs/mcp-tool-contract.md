# Shared MCP tool contract

Self-hosted Fluxmail and Fluxmail Cloud offer 34 of the same MCP tools. `@fluxmail/core/mcp` publishes what the two products share, with no runtime dependencies and no Zod:

- `MAIL_SCOPES`, `PERMISSION_PRESETS` and `MODIFY_ACTION_SCOPES`
- `SHARED_TOOLS`: each tool's name, title, base description, scope (`null` for support tools), optional `alsoRequires` scope, annotations, and input and output JSON Schemas
- Result shaping both products use: body and thread paging, modify action arguments, attachment resources and inline content, PDF text formatting, MCP client classification for telemetry, and `invalidArgumentProperties`, which turns rejected tool arguments into the schema-derived `invalid_argument`, `invalid_reason` and `invalid_argument_count` telemetry properties

`@fluxmail/core/mcp/pdf` runs PDF text extraction in memory-limited workers, at most two at a time per process. Each product supplies its own worker module, which depends on `unpdf`. The worker calls `limitPdfWorkerMemory` from `@fluxmail/core/mcp/pdf-worker` before it loads pdf.js, and the returned `assertWithinLimit` before it posts a result: the worker heap limit doesn't cover the ArrayBuffers pdf.js decompresses streams into. `@fluxmail/core/search-cursor` signs search page tokens. Both subpaths need Node. The root `@fluxmail/core` export also holds the shared send and search behavior: reply sender selection, forward bodies, the search capability check and attachment download headers. The root and `mcp` exports use the global `Buffer`, so they need Node or a runtime that provides it.

## MCP Apps send confirmation

`@fluxmail/core/mcp` also publishes the MCP Apps card that shows a `preview_send` result as the email will be sent, with a Send button. Both products register it from these exports and copy no files:

- `SEND_CONFIRMATION_RESOURCE` for `resources/list`, and `sendConfirmationResourceContents()` for `resources/read` of `SEND_CONFIRMATION_RESOURCE_URI`. The contents hold `SEND_CONFIRMATION_HTML`, one self-contained document, and resource `_meta` with empty CSP domain lists and no permissions.
- `SEND_CONFIRMATION_TOOL_META`, the `_meta` that `preview_send`'s tool definition carries in `tools/list`.
- `sendConfirmationResultMeta({ idempotencyKey, body })`, the `_meta` a successful `preview_send` result carries under `SEND_CONFIRMATION_RESULT_META_KEY`. It holds the body as it will be sent, each part cut to `SEND_CONFIRMATION_MAX_BODY_CHARS`, the PNG, GIF, JPEG and WebP attachments the HTML shows as `cid:` images (as `data:` URLs, within `SEND_CONFIRMATION_MAX_IMAGE_CHARS` each and `SEND_CONFIRMATION_MAX_IMAGES_CHARS` in all), and the card's idempotency key. Self-hosted passes the resolved attachments of a direct send or reply; draft attachments carry no content, so their inline images stay placeholders. Content and `structuredContent` don't change.
- `issueSendConfirmationKey(secret, sendConfirmationContentHash(message))` makes that key for each preview. It is signed with a server secret and carries the preview time and a hash of the resolved message. `readSendConfirmationKey(secret, key)` returns `undefined` for any other key and `invalid` for a card key the server didn't sign or that is older than `SEND_CONFIRMATION_KEY_TTL_MS`.
- `clientSupportsMcpApps(capabilities)`. Offer the card unless it returns `false`. It returns `undefined` when a stateless request carries no client capabilities, and hosts without the extension ignore `_meta`.

The card's Send button calls `send_email` through the host with the `preview_send` tool input, the previewed `accountId` and the key from the result, so the server applies the same scope checks. When `send_email` receives a card key, the server refuses a key it can't read, then lets a repeat of the card's own send return the saved result. Otherwise it refuses the send when another send or forward from the same member and mailbox started after the preview, or when the message it resolves now no longer matches the previewed hash. A double click, re-render or retry delivers once, a card can't send after the model already sent the email, and a draft changed after the preview isn't sent unseen. Self-hosted does this in its MCP `send_email` handler (`EmailService.checkConfirmedSend`), for immediate and scheduled sends; the secret is derived from the store's persistent secret. The card reports each outcome to the model with `ui/update-model-context`, or a `ui/message` when the host refuses that. The card has no Edit button: to change the email, the user tells the assistant, which previews it again. Change the resource URI when the card changes incompatibly, because hosts may cache it by URI.

## MCP Apps message reader

`@fluxmail/core/mcp` also publishes a read-only card that shows a `get_email` result as the email was sent: sender, reply-to, recipients, date, subject, the body and attachment names and sizes. `get_email` is the one tool linked to it. `get_email_body` pages a body for the model and `get_thread` returns several messages, so linking either would show a card for every page or every message. Both products register it from these exports:

- `MESSAGE_READER_RESOURCE` for `resources/list`, and `messageReaderResourceContents()` for `resources/read` of `MESSAGE_READER_RESOURCE_URI`. The contents hold `MESSAGE_READER_HTML` and resource `_meta` with empty CSP domain lists and no permissions.
- `MESSAGE_READER_TOOL_META`, the `_meta` that `get_email`'s tool definition carries in `tools/list` when the card is offered.
- `messageReaderResultMeta({ message, returned, inlineImages, includeBody })`, the `_meta` a successful `get_email` result carries under `MESSAGE_READER_RESULT_META_KEY`. `message` is the message as read and `returned` is the selected body the result gives the model. Only a body part the result cut or left out rides in `_meta`, cut to `MESSAGE_READER_MAX_HTML_CHARS` or `MESSAGE_READER_MAX_TEXT_CHARS`, so the card repeats nothing the result already carries. Pass `includeBody: false` unless the client declared MCP Apps support (`clientSupportsMcpApps` returns `true`): a client whose support is unknown may not show the card, so it gets no extra body and the card shows the result's own copy. Content and `structuredContent` don't change.
- `messageReaderInlineImages(message)` lists the attachments to fetch for `cid:` images: PNG, GIF, JPEG and WebP that the HTML references by exact Content-ID, at most `MESSAGE_READER_MAX_IMAGE_BYTES` each, `MESSAGE_READER_MAX_IMAGES_CHARS` of base64 in all and `MESSAGE_READER_MAX_INLINE_IMAGES` images. Self-hosted fetches them only for clients that declared support, in parallel, and waits at most four seconds; an image that fails or is still loading stays a placeholder.

Received mail is untrusted, so the card renders it in the shared renderer's `received` mode: remote images stay placeholders (an MCP Apps resource declares its allowed origins ahead of time, and a message's image hosts aren't known then), tracking images are left out and counted, passages mail apps hide are left out behind a Show hidden text control, and links show their real destination: international hosts as punycode, direction overrides and user names before the host removed, and the host kept in view when a long address is clipped. A dark email's body colors and a button-style link's own colors are kept so their text stays readable. A link opens only when the user activates it, through the host's `ui/open-link`. The card calls no tools.

## Shared views and mail HTML renderer

Both cards are built from `viewKit.ts` (base styles, the MCP Apps postMessage bridge, host theming and sizing) and the mail HTML renderer in `@fluxmail/core/mail-html`. `createMailHtmlRenderer(document, DOMParser)` parses HTML inertly and rebuilds it from an allowlist with DOM APIs; `draft` mode is the send card's rendering and `received` mode adds the rules above. The function is self-contained so a view can inline its source, and other browser surfaces can import it from `@fluxmail/core/mail-html`. That subpath uses only browser globals.

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
