# MCP protocol adapter

The server supports MCP `2026-07-28` and legacy clients over HTTP and stdio. Production dependencies pin `@modelcontextprotocol/server` and `@modelcontextprotocol/core` to `2.4.0`. Tests use `@modelcontextprotocol/client` `2.4.0` and the Node adapter `2.1.2`.

The migration follows the official [v2 upgrade guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md) and [2026-07-28 guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md). The installed packages supply the transport classification, negotiation, validation, and wire codecs.

## HTTP lifecycle

`POST /mcp` authenticates the request and checks the body limit before calling `createMcpHandler`. The factory receives the existing principal-scoped email service and permissions. Modern discovery, tool calls, and resource reads need no initialization. Legacy clients use the handler's stateless fallback, including `initialize` and `notifications/initialized`.

The handler receives an independent request signal. Fluxmail reads the response to completion before returning it to Hono so accepted mail operations remain tracked by `RuntimeLifecycle` after a client disconnects. This preserves provider completion, delivery-ledger writes, and graceful shutdown. Legacy responses use the SDK's SSE framing; modern responses normally use JSON. Both are buffered until completion.

Tool and resource lists are fixed for each authorized request. The server does not advertise list-change notifications, and the HTTP handler rejects subscription streams through the SDK's `maxSubscriptions: 0` setting. It retains the existing GET and DELETE rejection behavior.

## Stdio lifecycle

`serveStdio` owns protocol selection and pins the server instance to the connection. The CLI still requires a local member session, applies mailbox restrictions and the selected permission profile, and defaults to read-only. It does not start a scheduled delivery worker.

Attachment resource links use the validated HTTP protocol header or the SDK's negotiated-version accessor. Clients older than `2025-06-18` receive the attachment URI as text. Modern stdio clients use the pinned version without an initialization handshake.

## Tool compatibility

The MCP boundary exposes the existing Zod 3 validators through Standard Schema. This retains nullable optional inputs, transforms, and validation behavior without changing schemas used by REST and configuration. JSON Schema conversion continues to use the existing converter.

`packages/server/test/fixtures/mcp-contract.json` is the full snapshot of all 34 tools. Tests compare every tool name, title, description, input schema, output schema, and annotation. Legacy listings match the complete fixture. The modern codec removes the retired `execution.taskSupport` declaration; the tests allow only that difference. The tools shared with Cloud also follow the [shared tool contract](mcp-tool-contract.md).

A `tools/call` for a tool that is not registered returns a JSON-RPC `-32602` error, matching Fluxmail Cloud. This includes tools omitted because the connection lacks the required capability, such as `send_email` without `mail.send`. Argument validation failures for registered tools remain tool results with `isError: true`. SDK 1.29.0 returned unknown tools as tool results too; clients that read that text now receive the protocol error instead. Service error codes, licensing, permission checks, and delivery idempotency are unchanged.

Discovery and legacy initialization share the fixed client-category telemetry classifier. See [telemetry](telemetry.md) for event fields and coverage limits.

## Verification

`mcpProtocol.test.ts` covers both HTTP generations, the full tool contract, API keys, mailbox restrictions, denied scopes, argument validation, resource reads, attachment limits, confirmed and uncertain send retries, and direct modern requests without discovery. It also checks unknown-tool, scope-omitted-tool, and invalid-argument errors over HTTP and in-process stdio for both generations. `app.test.ts` checks draining after disconnect for both generations. `oauthSdk.test.ts` exercises authorization, refresh, and revocation for each generation. Stdio process tests exercise both generations, resource retrieval, and send replay with a synthetic provider.

Run `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm format:check`, `pnpm docs:generate`, and `pnpm docs:check` after adapter changes. Tests use synthetic providers and never send real mail.

## Cloud coordination

This migration changes the server adapter and its dependencies. It does not change `@fluxmail/core`, mail scopes, permission profiles, per-tool requirements, or the shared tool contract. Cloud needs its own MCP adapter migration; a core version bump cannot supply protocol support.

The Cloud fixture inspected on October 25, 2026 already differed from the self-hosted baseline. `@fluxmail/core/mcp` now publishes the [shared tool contract](mcp-tool-contract.md) that reconciles titles, descriptions, annotations, scopes and input schemas.
