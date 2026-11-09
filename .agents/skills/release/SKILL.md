---
name: release
description: Run a Fluxmail release from compatibility audit through verified publication. Use when preparing, publishing, resuming, or verifying a Fluxmail release; choosing a semantic version; generating Common Changelog notes; opening and merging a release pull request; monitoring the release workflow; or checking npm, GHCR, GitHub Release, and MCP Registry state.
---

# Release Fluxmail

Own the release from start to finish. Run commands from the repository root and use `scripts/release.mjs`, `scripts/publish.mjs`, and `scripts/release-config.mjs` as the executable source of truth.

Treat an invocation of `$release` as authorization to complete reversible preparation: inspect state, edit release files, validate, commit, push, open or update a pull request, and monitor CI. It does not authorize live registry writes. Ask for approval once, after showing the exact release contents and before merging or dispatching publication.

Do not ask the user to run commands. Handle tool use, retries, PR updates, and workflow monitoring. Pause only when the user must authenticate, approve live publication, authorize external setup changes, resolve an inconsistent published state, or make a genuinely ambiguous compatibility decision.

## Find the current state

Fetch `origin/main` and tags, inspect the current branch and pull request, and query relevant workflow runs. Derive the next action from GitHub and registry state instead of relying on a local progress file.

- No release pull request: audit, prepare, validate, and open one.
- Open release pull request: update it if needed, wait for CI, and fix failures.
- Merged release pull request with no workflow: dispatch publication from its full merge SHA.
- Failed or partial publication: resume from the first missing destination.
- Published release: verify every destination and report the result.

Never overwrite unrelated work or prepare a release from a dirty tree. If the current workspace contains unrelated changes, preserve them and use a clean release workspace or branch.

## Run preflight

Run:

```bash
pnpm release doctor --json
```

The publish workflow uses npm trusted publishing through GitHub OIDC. Do not run `npm login`, request an npm authenticator code, or run `--npm-trust` during routine release preparation, including a first release. The protected publish workflow checks the existing trust settings when it publishes. A successful prior release from the same repository, workflow file, and `release` environment also confirms those settings worked.

Run the separate setup audit when changing npm trusted-publisher settings, when the workflow reports a trusted-publisher problem, or when the user explicitly requests an npm trust audit. After changing settings, rerun the audit before publishing:

```bash
pnpm release doctor --json --npm-trust
```

Read `docs/releasing.md` only when preflight reports missing external setup or when troubleshooting a failure. Fix safe repository-local problems directly. Before changing npm or GitHub configuration, show the proposed external changes and ask for one setup approval. Do not add a required environment reviewer unless the user asks for a second approval gate.

If that setup audit reports that login is required, start `npm login` and let the user complete browser authentication. If npm reports a separate authentication URL, open it when browser control is available. Otherwise, give the user that one URL and resume as soon as authentication completes. Configure missing trusted publishers during npm's five-minute bulk window, then rerun the setup audit.

## Audit and choose the version

Find the nearest eligible published release that is an ancestor of the candidate. Use published, stable releases for a stable candidate and include published prereleases for a prerelease candidate. Inspect the complete first-parent log and diff from that tag through the candidate.

Review CLI behavior, configuration and environment variables, MCP tools and schemas, REST behavior, package exports and types, stored data, authentication, defaults, and runtime requirements.

Treat MCP, CLI, and REST as Fluxmail's supported client contracts. A change is breaking only when an existing integration using at least one of those interfaces must change to keep working. Package exports and types, custom provider APIs, stored data formats, server configuration, licensing, and runtime requirements can need upgrade notes, but they do not count as breaking on their own and do not determine a breaking version bump. If one of those changes also forces an MCP, CLI, or REST client to change, classify only the affected client interfaces as breaking.

Choose the minimum compatible semantic version:

- At `1.0.0` or later, use a major bump for a breaking MCP, CLI, or REST contract.
- At `0.y.z` where `y` is at least 1, use a minor bump for a breaking MCP, CLI, or REST contract.
- Use a minor bump for backward-compatible functionality.
- Use a patch bump for backward-compatible fixes only.
- Do not release internal work, tests, documentation, or release tooling unless it changes user-visible behavior on a supported product surface.

Choose the version without asking when the evidence is clear. Report the baseline, audited range, compatibility findings, and selected version before editing files. Stop if there is no release-worthy change.

## Prepare and validate

From a clean tree based on the latest `origin/main`, run:

```bash
pnpm release prepare <version>
```

Curate the generated `CHANGELOG.md` entry for users. Follow Common Changelog:

- Use applicable H3 groups in this order: `Changed`, `Added`, `Removed`, and `Fixed`.
- Write imperative, single-line bullets that end with the best pull request, issue, or commit link.
- Begin every bullet that affects MCP, CLI, or REST with one bracketed interface label. Use only `MCP`, `CLI`, and `REST`, in that order, such as `[MCP]`, `[MCP / CLI]`, or `[MCP / CLI / REST]`. Leave bullets that do not affect these interfaces untagged.
- Include only affected interfaces in the label. Combine interfaces only when one bullet accurately describes the same change for each one, and split the bullet when their behavior or migration differs.
- Reserve `**Breaking:**` for changes that require an existing MCP, CLI, or REST client to change. Put those entries first, place `**Breaking:**` immediately after the interface label, and include a migration step or link.
- Every breaking entry must begin with the affected MCP, CLI, or REST interface label. Do not mark stored data, custom provider APIs, package exports or types, server configuration, licensing, or runtime requirements as breaking on their own. Describe any required operator or developer action under `Changed` and link its upgrade guide.
- Use the names from public documentation. Do not present an internal package as a supported interface or recommend direct use unless the public docs explicitly support it.
- Split breaking entries when client interfaces require different migration steps. Combine interfaces only when the same break and migration apply to each one.
- Name every affected interface for shared breaks such as invalid page tokens, and state that users of other interfaces do not need that migration.
- When a release has several interface-specific migrations, add the same compact surface map to the public upgrade guide and preserve the scoping in the approval packet.
- Merge related changes within a surface and omit empty groups, authors for this single-contributor project, and internal work.
- Use `_No user-facing changes._` only when the audited range has no user-facing changes.

Audit the entry against the full commit range and do not invent changes. If the notes reveal a higher-impact change, prepare the correct version instead.

Run the full release checks:

```bash
pnpm release validate --version <version>
pnpm format:check
pnpm lint
pnpm build
pnpm typecheck
pnpm docs:check
pnpm test
pnpm publish:all --dry-run --tag <latest-or-next>
```

Fix failures and rerun affected checks. Commit the version files and changelog together, push the release branch, open a draft pull request, and wait for CI. Keep the PR current until all required checks pass.

## Ask for publication approval

Present one approval packet containing:

- selected version and compatibility reasoning
- complete changelog entry
- npm tag, Git tag, and release commit
- pull request link and concise diff summary
- npm, GHCR, MCP Registry, Git tag, and GitHub Release as the destinations

Ask the user to approve or reject that exact release. Do not merge the release pull request or dispatch the workflow before approval. Treat a clear response such as `approve` as authorization to merge and publish the reviewed release.

## Merge and publish

After approval, confirm the pull request has not changed, mark it ready if needed, and merge it using the repository's permitted merge method. Fetch `main`, record the full merge commit SHA, and confirm that it contains the approved changelog.

Dispatch the workflow with the exact version, SHA, and npm tag:

```bash
gh workflow run publish-release.yml \
  --repo fluxmailai/fluxmail \
  -f version=<version> \
  -f release_sha=<full-main-commit-sha> \
  -f npm_tag=<latest-or-next>
```

Surface the workflow URL and monitor it through completion. Fix validation failures in a new pull request when the release tree is wrong. For transient or partial publish failures, rerun only the failed job so the saved package build and image digests are reused; after they expire in one day, rerun the whole workflow. The build, validation, and per-platform image jobs push images by digest only and tag nothing. The publish job starts after validation passes and writes npm, GHCR (joining the platform images under the version and channel tags), the MCP Registry, the Git tag, and the GitHub Release in that order.

Use local publishing only when GitHub Actions is unavailable and the user separately approves the fallback.

## Resume and verify

Inspect partial state with:

```bash
pnpm release status --version <version> --json
```

Keep these stop conditions:

- Stop if Docker exists while any npm package is missing.
- Stop if an existing npm version has a missing or stale `latest` or `next` tag without a consistent newer release. The OIDC workflow cannot repair that tag.
- Stop if a published GitHub Release exists while another destination is missing.
- Stop if a tag points to a commit other than the approved release SHA.
- Stop if a draft GitHub Release contains uploaded assets.
- Never republish an existing immutable npm or MCP Registry version.

When a newer release already owns the npm and Docker channel tags, treat the older release as a historical resume. Publish only its missing immutable destinations and leave the newer channels unchanged.

Otherwise, resume with the same version, SHA, and npm tag. Do not claim success until this passes:

```bash
pnpm release verify \
  --version <version> \
  --sha <full-release-commit-sha> \
  --npm-tag <latest-or-next>
```

Finish with the version, release SHA, pull request, workflow, GitHub Release, package destinations, and any skipped or manually verified checks.
