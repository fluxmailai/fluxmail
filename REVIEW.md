# Code review guide

The `code-reviewer` agent reads this file before it reviews a branch. Keep it short. When a bug ships that review should have caught, add its pattern to the list of failures below.

When a branch changes this file, review it under both the base's version and the branch's, and use whichever is stricter for each rule.

## Review depth

Use `medium` when every changed file is one of these, whatever the size of the change:

- a hand-written `.md` page in `docs/public/pages/`, except `telemetry.md`, `permissions.md` and `teams-and-plans.md`
- a hand-written `meta.json` under `docs/public/pages/`, or a file regenerated from these pages, such as `docs/public/manifest.json` and `llms-install.md`
- an image under `docs/assets/`

Otherwise, use `xhigh` when any changed file is in one of these paths:

- Licensing and quota gates: `packages/server/src/licensing/`, `packages/server/src/mcp/buildServer.ts`
- Accounts, sign-in and access: `packages/server/src/auth.ts`, `packages/server/src/authorization.ts`, `packages/server/src/permissions.ts`, `packages/server/src/accounts/`, `packages/server/src/oauth/`, `packages/server/src/http/`, `packages/server/src/storage/`, `packages/server/src/cliCloudAuth.ts`, `packages/server/src/cliCloudClient.ts`, `packages/server/src/cliInstances.ts`, `packages/core/src/access/`
- The contract Cloud and released clients use: `packages/core/src/mcp/`, `packages/core/src/index.ts`, `packages/core/src/provider.ts`, `packages/core/src/types.ts`, `packages/core/src/errors.ts`, and the provider adapters in `packages/provider-gmail/src/`, `packages/provider-outlook/src/` and `packages/provider-imap/src/`
- Sending: `packages/server/src/service/emailService.ts`, `packages/server/src/service/deliveryCoordinator.ts`, `packages/server/src/scheduler/`, `packages/server/src/sendAt.ts`
- Telemetry and upgrades: `packages/server/src/telemetry.ts`, `packages/server/src/config.ts`, `packages/server/src/configMigration.ts`, `packages/server/src/deploymentConfig.ts`, `packages/server/src/instanceConfig.ts`
- Release and packaging: `.github/`, `scripts/release.mjs`, `scripts/release-config.mjs`, `scripts/publish.mjs`, `scripts/claude-code-plugin.mjs`, `scripts/build-mcpb.mjs`, `mcpb/`, `integrations/`, `server.json`, `Dockerfile`, `docker-compose.yml`, `package.json`, `packages/*/package.json`, `pnpm-workspace.yaml`
- The review process: `REVIEW.md`, `AGENTS.md`, `CLAUDE.md`, `.claude/agents/`, `.claude/hooks/`, `.claude/settings.json`
- Contract docs: `docs/license-validation-contract.md`, `docs/mcp-tool-contract.md`, `docs/access-contract.md`

Also use `xhigh` when the branch adds and deletes more than 1,000 lines of text in total. Don't count binary files or the files listed under Skip.

Use `high` for everything else.

## Security review

Run a security review as well when the branch changes a file in the `xhigh` groups for licensing and quota gates and for accounts, sign-in and access, or in `packages/server/src/service/`, `mcpb/launch.mjs`, `integrations/claude-code/launch.mjs`, `scripts/claude-code-plugin.mjs`, `pnpm-workspace.yaml`, `.github/workflows/` or `.github/actions/`.

Run one too when the diff anywhere reads a credential or secret, signs or checks a token, handles an OAuth redirect, decides which account or mailbox a caller can reach, changes a license or quota check, or installs dependencies. Also run one when the branch adds an `.mdx` file under `docs/public/pages/`, because the website compiles those pages as code.

## Failures to look for

Report every correctness bug and every High or Medium security finding as Important. Report these as Important too:

- Anything that lets someone use paid features, extra accounts or team features without a valid license, or weakens a license check. The License and subscription protection section of `CLAUDE.md` applies.
- A breaking change to what Cloud or installed clients rely on: an `@fluxmail/core` export, a shared MCP tool's name, arguments, annotations, scope or error semantics, a REST route or a CLI command's output that scripts parse. Shared tool metadata changes need `pnpm contract:generate` and a matching change in Cloud. The license client must keep matching `docs/license-validation-contract.md`.
- An upgrade that breaks an existing install: a config field renamed or removed without a migration, a storage schema change that can't open an older database, or a default that changes behavior for people who didn't opt in.
- Credential reach that widens a member's access to a mailbox, an API key or another member's data. See `docs/access-contract.md`.
- A send that can run twice for one request, for example a retry that ignores the idempotency key or a scheduled send that fires after cancellation.
- Telemetry that sends anything the Anonymous telemetry section of `CLAUDE.md` forbids, or a new user-visible CLI command, MCP tool or REST operation without `captureOperation`. The `mcp_client_name` and `mcp_client_version` fields are an approved exception.
- A test or script that sends mail from, or changes, a real account.
- Anything that breaks a rule in the Writing style, User-facing documentation or Anonymous telemetry sections of `CLAUDE.md`, including hand edits to generated docs.

## Skip

- `pnpm-lock.yaml`, the generated reference pages under `docs/public/pages/tools/`, `docs/public/pages/cli/` and `docs/public/pages/rest-api/`, `docs/public/manifest.json` and binary files
- formatting and style that oxfmt, oxlint and TypeScript already check

## Reporting

Give a file and line for each finding and say what goes wrong and when. Tag each finding Important or Nit, and report at most three nits.
