# Fluxmail MCP bundle

The Fluxmail bundle is a prebuilt MCPB for local stdio servers. It runs on Windows and macOS on x64 or ARM64, and on Linux on x64 or ARM64 with glibc or musl. It requires Node.js 22.22 or later. MCPB lists supported operating systems in its manifest but has no CPU architecture field, so the bundle selects its native binaries when it starts.

Build from a checkout of the matching Fluxmail version with Node.js 22.22 or later:

```bash
pnpm install --frozen-lockfile
pnpm mcpb:build
```

The build writes `fluxmail-<version>.mcpb` to `.context/mcpb/`, following MCPB 0.3. Verification also resolves saved Full, read-write, and read-only profiles and checks their tool restrictions.

The build uses a hoisted production install. It includes the Node-API Argon2 and SQLite binaries for each supported system. better-sqlite3 ships its SQLite binaries in its npm package and loads them without an install script. The build removes SQLite source files and unused Google API clients. It then extracts the archive and checks the CLI, SQLite, Argon2, and MCP tools. CI checks the extracted bundle on Ubuntu and Alpine for every pull request. It also runs the bundle on Windows, macOS, and ARM64 Linux for pushes to `main` and for pull requests that change dependencies, `mcpb/`, or the bundle scripts. `pnpm contract:generate` writes the tool list in `mcpb/manifest.template.json` from the tools a bundle install gets with its default Full profile, using the first sentence of each tool's description. `pnpm contract:check` fails in CI when the list is stale.

Users need to complete the [Fluxmail quickstart](https://fluxmail.ai/docs/quickstart) and connect a mailbox before installing the bundle. It uses their existing local Fluxmail data and login. The archive contains no credentials or mailbox data.
