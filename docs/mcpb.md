# Fluxmail MCP bundle

Smithery accepts a prebuilt MCPB for local stdio servers. The Fluxmail bundle runs on Windows and macOS on x64 or ARM64, and on Linux on x64 or ARM64 with glibc or musl. It requires Node.js 22.22 or later. MCPB lists supported operating systems in its manifest but has no CPU architecture field, so the bundle selects its native binaries when it starts.

Build from a checkout of the matching Fluxmail version with Node.js 22.22 or later:

```bash
pnpm install --frozen-lockfile
pnpm mcpb:build
```

The build writes `fluxmail-<version>.mcpb` and `fluxmail-<version>-smithery.mcpb` to `.context/mcpb/`. The first follows MCPB 0.3. Smithery requires `inputSchema` on each manifest tool, although MCPB 0.3 rejects that field. The Smithery archive adds schemas returned by Fluxmail's MCP server with the bundle's resolved Full profile, excluding the permanent-delete tool. Verification also resolves saved Full, read-write, and read-only profiles and checks their tool restrictions.

The build uses a hoisted production install. It includes the Node-API Argon2 and SQLite binaries for each supported system. better-sqlite3 ships its SQLite binaries in its npm package and loads them without an install script. The build removes SQLite source files and unused Google API clients to stay under Smithery's 25 MB upload limit. It then extracts both archives and checks the CLI, SQLite, Argon2, and MCP tools. CI checks the extracted bundle on Ubuntu and Alpine for every pull request. It also runs the bundle on Windows, macOS, and ARM64 Linux for pushes to `main` and for pull requests that change dependencies, `mcpb/`, or the bundle scripts. `pnpm contract:generate` writes the tool list in `mcpb/manifest.template.json` from the tools a bundle install gets with its default Full profile, using the first sentence of each tool's description. `pnpm contract:check` fails in CI when the list is stale.

Users need to complete the [Fluxmail quickstart](https://fluxmail.ai/docs/quickstart) and connect a mailbox before installing the bundle. It uses their existing local Fluxmail data and login. The archive contains no credentials or mailbox data.

After each stable release, the publish workflow publishes the bundle to the [Fluxmail listing](https://smithery.ai/servers/fluxmail/fluxmail) through the Publish to Smithery workflow. It waits for the MCP bundle run of the release commit to pass, downloads that run's `fluxmail-mcpb` artifact, and publishes `fluxmail-<version>-smithery.mcpb` with the Smithery CLI pinned in `mcpb/smithery/`. It needs a Smithery API key from the account that owns the `fluxmail` namespace, saved as the `SMITHERY_API_KEY` secret of the `release` environment. Without the key, or when Smithery doesn't confirm the release, the job fails without failing the release run. A release older than npm's `latest` is skipped, so Smithery keeps the newer bundle.

To publish a release again, run the Publish to Smithery workflow from `main` with the version and the release commit's full SHA. To publish by hand instead:

```bash
smithery auth login
smithery mcp publish .context/mcpb/fluxmail-<version>-smithery.mcpb -n fluxmail/fluxmail
```

Check the published listing and install command after Smithery finishes processing the release.
